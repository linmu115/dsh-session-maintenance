import type { DatabaseSync } from "node:sqlite";
import {
  instanceWorkspaceInstanceIdSchema, instanceWorkspacePolicySchema, instanceWorkspacePolicyUpdateSchema,
  type InstanceWorkspacePolicy, type InstanceWorkspacePolicyUpdate, type LogicalSessionId, type LogicalWorkspaceId, type ProjectionRun,
} from "@linmu/dsh-session-contracts";

export type InstanceWorkspacePolicyErrorCode = "INSTANCE_WORKSPACE_POLICY_CONFLICT" | "INSTANCE_WORKSPACE_UNKNOWN"
  | "SESSION_NOT_SYNCED" | "SESSION_NOT_FOUND" | "SESSION_DELETED";
export class InstanceWorkspacePolicyError extends Error {
  constructor(readonly code: InstanceWorkspacePolicyErrorCode, message: string) { super(message); this.name = "InstanceWorkspacePolicyError"; }
}
export interface InstanceSessionScope {
  readonly status: "allowed" | "not-synced" | "missing" | "deleted";
  readonly policyRevision: number;
  readonly workspaceId: LogicalWorkspaceId | null;
}
function selected(policy: InstanceWorkspacePolicy, workspaceId: LogicalWorkspaceId | null): boolean {
  return policy.selection.kind === "all" || (workspaceId === null
    ? policy.selection.includeUnassigned : policy.selection.workspaceIds.includes(workspaceId));
}

/** Synchronous reads participate in the caller's canonical commit transaction. No cached policy. */
export class SqliteInstanceWorkspacePolicyRepository {
  constructor(readonly database: DatabaseSync, private readonly clock: () => string = () => new Date().toISOString()) {}
  getPolicy(instanceId: string): InstanceWorkspacePolicy {
    instanceWorkspaceInstanceIdSchema.parse(instanceId);
    const row = this.database.prepare("SELECT revision, selection_json, updated_at FROM instance_workspace_policies WHERE instance_id = ?")
      .get(instanceId) as { revision: number; selection_json: string; updated_at: string } | undefined;
    return instanceWorkspacePolicySchema.parse({ schemaVersion: 1, instanceId, revision: row?.revision ?? 0,
      selection: row ? JSON.parse(row.selection_json) : { kind: "all" }, updatedAt: row?.updated_at ?? null });
  }
  /** Freeze the selected scope before materialization; later saves apply to the next run. */
  policyForRun(run: Pick<ProjectionRun, "id" | "instanceId" | "profileId" | "state">): InstanceWorkspacePolicy {
    const existing = this.database.prepare("SELECT instance_id, policy_json FROM projection_run_workspace_scopes WHERE run_id=?")
      .get(run.id) as { instance_id: string; policy_json: string } | undefined;
    if (existing) {
      const policy = instanceWorkspacePolicySchema.parse(JSON.parse(existing.policy_json));
      if (existing.instance_id !== run.instanceId || policy.instanceId !== run.instanceId) throw new Error("Projection scope belongs to another instance");
      return policy;
    }
    const stored = this.database.prepare("SELECT instance_id, profile_id FROM projection_runs WHERE id=?").get(run.id) as { instance_id: string; profile_id: string } | undefined;
    if (stored && (stored.instance_id !== run.instanceId || stored.profile_id !== run.profileId)) throw new Error("Projection scope identity mismatch");
    // Existing pre-upgrade runs were projected with all workspaces. Recovery
    // must retain that effective policy instead of applying a newly saved one.
    const policy = run.state === "preparing" || !stored ? this.getPolicy(run.instanceId)
      : instanceWorkspacePolicySchema.parse({ schemaVersion: 1, instanceId: run.instanceId, revision: 0, selection: { kind: "all" }, updatedAt: null });
    if (stored && run.state === "preparing") this.database.prepare("INSERT INTO projection_run_workspace_scopes(run_id,instance_id,policy_json) VALUES (?,?,?)")
      .run(run.id, run.instanceId, JSON.stringify(policy));
    return policy;
  }

  workspaceSelected(policy: InstanceWorkspacePolicy, workspaceId: LogicalWorkspaceId | null): boolean { return selected(policy, workspaceId); }
  /** A live creation extends content, not the cache identity established at prepare time. */
  cacheRevisionForRun(run: Pick<ProjectionRun, "id" | "instanceId" | "profileId" | "state">): number {
    const policy = this.policyForRun(run);
    const row = this.database.prepare("SELECT cache_revision FROM projection_run_workspace_scopes WHERE run_id=?").get(run.id);
    return typeof row?.cache_revision === "number" ? row.cache_revision : policy.revision;
  }
  /** Enrol only a newly created workspace; do not activate unrelated pending edits. */
  enrollCreatedWorkspace(run: Pick<ProjectionRun, "id" | "instanceId" | "profileId" | "state">, workspaceId: LogicalWorkspaceId): void {
    const active = this.policyForRun(run);
    const previous = this.getPolicy(run.instanceId);
    const saved = selected(previous, workspaceId) ? previous : this.updatePolicy(run.instanceId, {
      expectedRevision: previous.revision,
      selection: previous.selection.kind === "all" ? previous.selection : {
        ...previous.selection, workspaceIds: [...previous.selection.workspaceIds, workspaceId],
      },
    });
    const effective = { ...active,
      revision: active.revision === previous.revision ? saved.revision : active.revision,
      selection: active.selection.kind === "all" ? active.selection : {
        ...active.selection, workspaceIds: [...new Set([...active.selection.workspaceIds, workspaceId])].sort(),
      },
    };
    const cacheRevision = this.cacheRevisionForRun(run);
    this.database.prepare(`INSERT INTO projection_run_workspace_scopes(run_id,instance_id,policy_json,cache_revision) VALUES (?,?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET policy_json=excluded.policy_json,cache_revision=excluded.cache_revision WHERE instance_id=excluded.instance_id`)
      .run(run.id, run.instanceId, JSON.stringify(effective), cacheRevision);
  }
  updatePolicy(instanceId: string, input: InstanceWorkspacePolicyUpdate): InstanceWorkspacePolicy {
    instanceWorkspaceInstanceIdSchema.parse(instanceId);
    const update = instanceWorkspacePolicyUpdateSchema.parse(input);
    // A savepoint composes with the Engine's existing writer transaction and
    // rolls back only this mutation if validation or compare-and-swap fails.
    this.database.exec("SAVEPOINT instance_workspace_policy_update");
    try {
      const previous = this.getPolicy(instanceId);
      if (previous.revision !== update.expectedRevision)
        throw new InstanceWorkspacePolicyError("INSTANCE_WORKSPACE_POLICY_CONFLICT", "Instance workspace policy changed; reload before saving");
      if (update.selection.kind === "ids") {
        const exists = this.database.prepare("SELECT id FROM logical_workspaces WHERE id = ? AND deleted_at IS NULL");
        for (const id of update.selection.workspaceIds) if (!exists.get(id))
          throw new InstanceWorkspacePolicyError("INSTANCE_WORKSPACE_UNKNOWN", `Workspace is unknown or deleted: ${id}`);
      }
      const policy = instanceWorkspacePolicySchema.parse({ schemaVersion: 1, instanceId, revision: previous.revision + 1,
        selection: update.selection.kind === "all" ? update.selection : { ...update.selection, workspaceIds: [...update.selection.workspaceIds].sort() }, updatedAt: this.clock() });
      const result = this.database.prepare(`INSERT INTO instance_workspace_policies(instance_id, revision, selection_json, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(instance_id) DO UPDATE SET revision=excluded.revision,
        selection_json=excluded.selection_json, updated_at=excluded.updated_at WHERE instance_workspace_policies.revision = ?`)
        .run(instanceId, policy.revision, JSON.stringify(policy.selection), policy.updatedAt, update.expectedRevision);
      if (result.changes !== 1) throw new InstanceWorkspacePolicyError("INSTANCE_WORKSPACE_POLICY_CONFLICT", "Instance workspace policy changed; reload before saving");
      this.database.exec("RELEASE instance_workspace_policy_update");
      return policy;
    } catch (error) {
      this.database.exec("ROLLBACK TO instance_workspace_policy_update");
      this.database.exec("RELEASE instance_workspace_policy_update");
      throw error;
    }
  }
  isWorkspaceSelected(instanceId: string, workspaceId: LogicalWorkspaceId | null): boolean {
    return selected(this.getPolicy(instanceId), workspaceId);
  }
  sessionScope(instanceId: string, logicalSessionId: LogicalSessionId): InstanceSessionScope {
    const policy = this.getPolicy(instanceId);
    const row = this.database.prepare(`SELECT s.tombstoned_at, m.workspace_id FROM logical_sessions s
      LEFT JOIN workspace_memberships m ON m.logical_session_id = s.id WHERE s.id = ?`)
      .get(logicalSessionId) as { tombstoned_at: string | null; workspace_id: LogicalWorkspaceId | null } | undefined;
    const workspaceId = row?.workspace_id ?? null;
    return { policyRevision: policy.revision, workspaceId, status: row === undefined ? "missing"
      : row.tombstoned_at !== null ? "deleted" : selected(policy, workspaceId) ? "allowed" : "not-synced" };
  }
  assertSessionAllowed(instanceId: string, logicalSessionId: LogicalSessionId): InstanceSessionScope {
    const result = this.sessionScope(instanceId, logicalSessionId);
    if (result.status !== "allowed") throw new InstanceWorkspacePolicyError(result.status === "missing" ? "SESSION_NOT_FOUND"
      : result.status === "deleted" ? "SESSION_DELETED" : "SESSION_NOT_SYNCED", `Session ${logicalSessionId}: ${result.status}`);
    return result;
  }
}
