import type { DatabaseSync } from "node:sqlite";
import {
  instanceWorkspaceInstanceIdSchema, instanceWorkspacePolicySchema, instanceWorkspacePolicyUpdateSchema,
  type InstanceWorkspacePolicy, type InstanceWorkspacePolicyUpdate, type LogicalSessionId, type LogicalWorkspaceId,
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
