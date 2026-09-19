import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { LogicalProjectId, LogicalWorkspaceId, NativeSessionId, ProjectionRun } from "@linmu/dsh-session-contracts";
import { InstanceWorkspacePolicyError, SqliteInstanceWorkspacePolicyRepository } from "@linmu/dsh-session-store";

export interface RuntimeWorkspaceRegistrationInput {
  readonly run: ProjectionRun;
  readonly nativeSessionId: NativeSessionId;
  readonly projectId: LogicalProjectId;
  readonly workspaceId?: LogicalWorkspaceId;
}

/** Durable registration intent: retries finish the same creation, including after process recovery. */
export class RuntimeWorkspaceRegistration {
  private readonly policies: SqliteInstanceWorkspacePolicyRepository;
  constructor(private readonly database: DatabaseSync) { this.policies = new SqliteInstanceWorkspacePolicyRepository(database); }

  resolve(input: RuntimeWorkspaceRegistrationInput): LogicalWorkspaceId {
    this.database.exec("SAVEPOINT runtime_workspace_registration");
    try {
      const workspaceId = this.prepare(input);
      this.database.exec("RELEASE runtime_workspace_registration");
      return workspaceId;
    } catch (error) {
      this.database.exec("ROLLBACK TO runtime_workspace_registration; RELEASE runtime_workspace_registration");
      throw error;
    }
  }

  private prepare(input: RuntimeWorkspaceRegistrationInput): LogicalWorkspaceId {
    const { run, projectId, nativeSessionId } = input;
    const storedRun = this.database.prepare("SELECT instance_id,profile_id FROM projection_runs WHERE id=?").get(run.id);
    if (storedRun?.instance_id !== run.instanceId || storedRun?.profile_id !== run.profileId) throw new Error("Workspace registration belongs to another runtime");
    const previous = this.database.prepare("SELECT project_id,workspace_id,requested_workspace_id FROM runtime_workspace_registrations WHERE run_id=? AND native_session_id=?")
      .get(run.id, nativeSessionId);
    if (previous) {
      if (previous.project_id !== projectId || previous.requested_workspace_id !== (input.workspaceId ?? null)) throw new Error("Workspace registration identity changed on retry");
      this.assertSelected(run, previous.workspace_id as LogicalWorkspaceId);
      return previous.workspace_id as LogicalWorkspaceId;
    }
    const project = this.database.prepare("SELECT name FROM logical_projects WHERE id=? AND deleted_at IS NULL").get(projectId);
    if (!project || typeof project.name !== "string") throw new Error("Workspace registration project is missing or deleted");
    let workspaceId = input.workspaceId;
    if (workspaceId === undefined) {
      const binding = this.database.prepare("SELECT workspace_id FROM runtime_workspace_bindings WHERE instance_id=? AND project_id=?").get(run.instanceId, projectId);
      if (binding) workspaceId = binding.workspace_id as LogicalWorkspaceId;
      else {
        // A unique existing relation is usable; names and directory spelling are not workspace identities.
        const candidates = this.database.prepare(`SELECT DISTINCT w.id FROM project_memberships p
          JOIN workspace_memberships m ON m.logical_session_id=p.logical_session_id
          JOIN logical_workspaces w ON w.id=m.workspace_id
          JOIN logical_sessions s ON s.id=p.logical_session_id
          WHERE p.project_id=? AND w.deleted_at IS NULL AND s.tombstoned_at IS NULL ORDER BY w.id`).all(projectId);
        if (candidates.length > 1) throw new Error("Project belongs to multiple Maintenance workspaces; select an explicit workspace before creating a session");
        workspaceId = candidates[0]?.id as LogicalWorkspaceId | undefined;
      }
    }
    if (workspaceId !== undefined) this.assertSelected(run, workspaceId);
    else {
      // The instance/project binding gives a stable identity even before the first session commits.
      workspaceId = `workspace-runtime-${createHash("sha256").update(JSON.stringify([run.instanceId, projectId])).digest("hex").slice(0,32)}` as LogicalWorkspaceId;
      const at = new Date().toISOString();
      this.database.prepare("INSERT INTO logical_workspaces(id,parent_id,name,sort_key,created_at,updated_at) VALUES (?,NULL,?,?,?,?)")
        .run(workspaceId, project.name, project.name, at, at);
      this.database.prepare("INSERT INTO runtime_workspace_bindings(instance_id,project_id,workspace_id) VALUES (?,?,?)")
        .run(run.instanceId, projectId, workspaceId);
      this.policies.enrollCreatedWorkspace(run, workspaceId);
    }
    this.database.prepare("INSERT INTO runtime_workspace_registrations(run_id,native_session_id,project_id,workspace_id,requested_workspace_id) VALUES (?,?,?,?,?)")
      .run(run.id, nativeSessionId, projectId, workspaceId, input.workspaceId ?? null);
    return workspaceId;
  }

  private assertSelected(run: ProjectionRun, workspaceId: LogicalWorkspaceId): void {
    const workspace = this.database.prepare("SELECT deleted_at FROM logical_workspaces WHERE id=?").get(workspaceId);
    if (!workspace || workspace.deleted_at !== null) throw new Error("Workspace is missing or deleted");
    if (!this.policies.workspaceSelected(this.policies.policyForRun(run), workspaceId)) {
      throw new InstanceWorkspacePolicyError("SESSION_NOT_SYNCED", "此工作区未加入当前实例的同步范围，请先选择工作区并同步后再创建会话");
    }
  }
}
