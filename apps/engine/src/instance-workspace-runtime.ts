import type { DatabaseSync } from "node:sqlite";
import type { CanonicalEngineMutation } from "@linmu/dsh-canonical-session-engine";
import type { InstanceWorkspacePolicy, LogicalSessionId, LogicalWorkspaceId, MaintenanceWriteScope, ProjectionRun, RegisteredInstance, RunId } from "@linmu/dsh-session-contracts";
import { SqliteInstanceWorkspacePolicyRepository, InstanceWorkspacePolicyError } from "@linmu/dsh-session-store";
import { InstanceWorkspaceService } from "./instance-workspace-service.js";

interface RunRow { id: RunId; instance_id: string; profile_id: string; state: ProjectionRun["state"]; }
const runIdentity = (row: RunRow) => ({ id: row.id, instanceId: row.instance_id, profileId: row.profile_id, state: row.state });
const openStates = "'preparing','running','draining','verifying','recovery-required','recovering','quarantined','cleanup-pending'";

/** One provider for projection filtering, canonical commits, UI and Bridge consumers. */
export class InstanceWorkspaceRuntime {
  readonly policies: SqliteInstanceWorkspacePolicyRepository;
  constructor(private readonly database: DatabaseSync, private readonly instances: readonly RegisteredInstance[],
    private readonly writes: MaintenanceWriteScope, private readonly isRunOnline: (runId: RunId) => boolean = () => false) {
    this.policies = new SqliteInstanceWorkspacePolicyRepository(database);
  }

  private runs(instanceId: string, profileId?: string): RunRow[] {
    return this.database.prepare(`SELECT id,instance_id,profile_id,state FROM projection_runs WHERE instance_id=? AND state IN (${openStates})
      ${profileId === undefined ? "" : "AND profile_id=?"} ORDER BY started_at DESC,id DESC`)
      .all(...(profileId === undefined ? [instanceId] : [instanceId, profileId])) as unknown as RunRow[];
  }
  private workspaces() {
    return this.database.prepare("SELECT id,name,deleted_at FROM logical_workspaces ORDER BY sort_key,id").all() as unknown as { id: LogicalWorkspaceId; name: string; deleted_at: string | null }[];
  }
  private effective(instanceId: string, profileId: string): { policy: InstanceWorkspacePolicy; run: RunRow | undefined } {
    const runs = this.runs(instanceId, profileId), run = runs.find(item => this.isRunOnline(item.id));
    return { policy: run ? this.policies.policyForRun(runIdentity(run)) : this.policies.getPolicy(instanceId), run };
  }

  /** Called again within the canonical store transaction, including WAL recovery. */
  assertMutationAllowed = (mutation: CanonicalEngineMutation): void => {
    if (mutation.projectionReceipt === null) return;
    const run = this.database.prepare("SELECT id,instance_id,profile_id,state FROM projection_runs WHERE id=?")
      .get(mutation.projectionReceipt.runId) as RunRow | undefined;
    if (!run) throw new Error("Projection write has no registered instance scope");
    const policy = this.policies.policyForRun(runIdentity(run));
    const sourceId = mutation.derivation?.parentSessionId ?? mutation.session.id;
    const existing = this.database.prepare(`SELECT s.tombstoned_at,m.workspace_id FROM logical_sessions s
      LEFT JOIN workspace_memberships m ON m.logical_session_id=s.id WHERE s.id=?`).get(sourceId) as { tombstoned_at: string | null; workspace_id: LogicalWorkspaceId | null } | undefined;
    if (existing?.tombstoned_at) throw new InstanceWorkspacePolicyError("SESSION_DELETED", "Session was deleted before projection commit");
    const sourceWorkspace = existing ? existing.workspace_id : mutation.membership?.workspaceId ?? null;
    if (!this.policies.workspaceSelected(policy, sourceWorkspace)
      || (mutation.membership !== null && !this.policies.workspaceSelected(policy, mutation.membership.workspaceId)))
      throw new InstanceWorkspacePolicyError("SESSION_NOT_SYNCED", "当前绑定实例未同步此工作区；已保留未完成操作");
  };

  createService(): InstanceWorkspaceService {
    return new InstanceWorkspaceService({
      listInstances: async () => {
        // Launcher-prepared targets are authoritative even before an optional
        // read-only source registration is added to Engine configuration.
        const rows = this.database.prepare("SELECT DISTINCT instance_id FROM projection_runs").all() as {instance_id:string}[];
        const names = new Map(rows.map(row => [row.instance_id,row.instance_id]));
        for (const instance of this.instances) if (instance.platform === "dsh") names.set(instance.id,instance.displayName);
        return {instances:[...names].map(([instanceId,name])=>({instanceId,name}))};
      },
      readConfiguration: async instanceId => {
        const policy = this.policies.getPolicy(instanceId);
        // Open recovery records retain their frozen scope but are not current online runs.
        // Match effective()/availability and keep every distinct attested run, even for one profile.
        const activeScopes = this.runs(instanceId).filter(run => this.isRunOnline(run.id)).map(run => ({ profileId: run.profile_id, runId: run.id,
          policyRevision: this.policies.policyForRun(runIdentity(run)).revision, selection: this.policies.policyForRun(runIdentity(run)).selection }));
        return { policy, activeScopes, workspaces: this.workspaces().map(row => ({ id: row.id, name: row.name, deleted: row.deleted_at !== null })),
          pendingActivation: activeScopes.some(scope => scope.policyRevision !== policy.revision) };
      },
      writePolicy: (instanceId, input) => this.writes.run("instance-workspace-policy", async () => this.policies.updatePolicy(instanceId, input)),
      readEffectiveScope: async (instanceId, profileId) => {
        const { policy } = this.effective(instanceId, profileId);
        return { schemaVersion: 1, instanceId, profileId, policyRevision: policy.revision, selection: policy.selection,
          workspaces: this.workspaces().map(row => ({ workspaceId: row.id, name: row.name, deleted: row.deleted_at !== null,
            selected: row.deleted_at === null && this.policies.workspaceSelected(policy, row.id) })),
          includeUnassigned: this.policies.workspaceSelected(policy, null) };
      },
      readSessionAvailability: async (instanceId, logicalSessionId, profileId) => {
        const { policy, run } = this.effective(instanceId, profileId);
        const row = this.database.prepare(`SELECT s.tombstoned_at,m.workspace_id FROM logical_sessions s
          LEFT JOIN workspace_memberships m ON m.logical_session_id=s.id WHERE s.id=?`).get(logicalSessionId) as { tombstoned_at: string | null; workspace_id: LogicalWorkspaceId | null } | undefined;
        const workspaceId = row?.workspace_id ?? null;
        const base = { schemaVersion: 1 as const, instanceId, profileId, logicalSessionId: logicalSessionId as LogicalSessionId, workspaceId,
          policyRevision: policy.revision, nativeSessionId: null };
        if (!row) return { ...base, status: "not-found" as const };
        if (row.tombstoned_at) return { ...base, status: "deleted" as const };
        if (!this.policies.workspaceSelected(policy, workspaceId)) return { ...base, status: "not-synced" as const };
        if (!run) return { ...base, status: "offline" as const };
        const mappings = this.database.prepare(`SELECT native_session_id FROM projection_sessions WHERE run_id=? AND logical_session_id=?
          AND mode NOT IN ('hidden','recovery-only')`).all(run.id, logicalSessionId) as { native_session_id: string }[];
        return mappings.length === 1 ? { ...base, status: "available" as const, nativeSessionId: mappings[0]!.native_session_id }
          : { ...base, status: "mapping-pending" as const };
      },
    });
  }
}
