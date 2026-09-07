import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { IntegrationError } from "./integrations/bindings.js";

export interface MappingRetentionSelection {
  readonly sourceKeys: ReadonlySet<string>;
  readonly projectIds: ReadonlySet<string>;
  readonly projectAliases?: ReadonlyMap<string, string>;
}
export function codexSourceKey(instanceId: string, sessionId: string): string {
  return JSON.stringify([instanceId, sessionId]);
}
export function assertMappingRunsStopped(database: DatabaseSync): void {
  const row = database.prepare("SELECT count(*) AS n FROM projection_runs WHERE state IN ('preparing','running','draining','verifying','recovery-required','recovering','cleanup-pending')").get() as { n: number };
  if (row.n !== 0) throw new IntegrationError("MAPPING_RUNTIME_ACTIVE", "当前实例尚未完成会话回收，映射名单将在实例停止并恢复完成后生效。");
}

/** Only the explicit Codex selection grants automatic restoration eligibility. */
function selectedMappingKeepSet(database: DatabaseSync, selection: MappingRetentionSelection): Set<string> {
  const keep = new Set<string>();
  const bindings = database.prepare("SELECT logical_session_id, instance_id, session_id FROM platform_bindings WHERE platform='codex'").all() as unknown as Array<{ logical_session_id: string; instance_id: string; session_id: string }>;
  for (const row of bindings) if (selection.sourceKeys.has(codexSourceKey(row.instance_id, row.session_id))) keep.add(row.logical_session_id);
  // A native DSH conversation in an explicitly selected project is owned by
  // Maintenance. Mirror grouping is never trusted here: it may predate strict mapping.
  const natives = database.prepare("SELECT s.id, m.project_id FROM logical_sessions s JOIN project_memberships m ON m.logical_session_id=s.id WHERE s.origin_kind='maintenance-native'").all() as unknown as Array<{ id: string; project_id: string }>;
  for (const row of natives) if (selection.projectIds.has(row.project_id)) keep.add(row.id);
  const derivations = database.prepare("SELECT child_session_id, parent_session_id FROM session_derivations").all() as unknown as Array<{ child_session_id: string; parent_session_id: string }>;
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of derivations) if (keep.has(row.parent_session_id) && !keep.has(row.child_session_id)) { keep.add(row.child_session_id); changed = true; }
  }
  return keep;
}

/** Local DSH protection preserves existing progress; it never revives deleted records. */
function withActiveLocalDsh(database: DatabaseSync, selected: ReadonlySet<string>): Set<string> {
  const local = new Set((database.prepare(`SELECT s.id FROM logical_sessions s
    JOIN project_memberships m ON m.logical_session_id=s.id
    JOIN logical_projects p ON p.id=m.project_id
    WHERE p.source_platform='maintenance' AND s.authority_scope='maintenance'
      AND s.origin_kind='maintenance-native' AND s.tombstoned_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.logical_session_id=s.id AND t.restored_at IS NULL)`)
    .all() as unknown as Array<{ id: string }>).map(row => row.id));
  const descendants = database.prepare(`SELECT d.child_session_id,d.parent_session_id FROM session_derivations d
    JOIN logical_sessions s ON s.id=d.child_session_id
    JOIN session_versions v ON v.id=d.base_version_id AND v.logical_session_id=d.parent_session_id
    WHERE d.derivation_kind='dsh-continuation' AND s.authority_scope='maintenance'
      AND s.origin_kind='codex-derived' AND s.tombstoned_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.logical_session_id=s.id AND t.restored_at IS NULL)`)
    .all() as unknown as Array<{ child_session_id: string; parent_session_id: string }>;
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of descendants) if (local.has(row.parent_session_id) && !local.has(row.child_session_id)) {
      local.add(row.child_session_id); changed = true;
    }
  }
  return new Set([...selected, ...local]);
}

/** Explicit Codex identities plus still-active progress owned by local DSH projects. */
export function mappingKeepSet(database: DatabaseSync, selection: MappingRetentionSelection): Set<string> {
  return withActiveLocalDsh(database, selectedMappingKeepSet(database, selection));
}

/** Caller owns the write queue AND transaction, shared with policy activation. */
export function reconcileCodexProjectMapping(database: DatabaseSync, input: {
  readonly selection: MappingRetentionSelection; readonly revision: number; readonly at: string;
}): { removed: number; restored: number; kept: number; checkpointId: string | null } {
  assertMappingRunsStopped(database);
  for (const [oldId, newId] of input.selection.projectAliases ?? []) {
    database.prepare("UPDATE project_memberships SET project_id=?,revision=revision+1 WHERE project_id=?").run(newId, oldId);
  }
  const restorable = selectedMappingKeepSet(database, input.selection);
  const keep = withActiveLocalDsh(database, restorable);
  const rows = database.prepare("SELECT id, head_version_id, canonical_version_id, tombstoned_at FROM logical_sessions").all() as unknown as Array<{ id: string; head_version_id: string | null; canonical_version_id: string | null; tombstoned_at: string | null }>;
  const remove = rows.filter(row => row.tombstoned_at === null && !keep.has(row.id));
  const checkpointId = remove.length === 0 ? null : `checkpoint-project-mapping-${randomUUID()}`;
  if (checkpointId !== null) {
    const refs = Object.fromEntries(remove.flatMap(row => { const head = row.head_version_id ?? row.canonical_version_id; return head === null ? [] : [[`session:${row.id}`, head]]; }));
    database.prepare("INSERT INTO checkpoints (id,name,description,refs_json,backup_transaction_ids_json,created_by,created_at) VALUES (?,?,?,?, '[]','codex-project-mapping',?)")
      .run(checkpointId, "项目映射名单切换前的恢复点", `映射名单第 ${input.revision} 版：从 Maintenance 移除 ${remove.length} 个范围外会话，Codex 源保持不变。`, JSON.stringify(refs), input.at);
  }
  const retentionUntil = new Date(Date.parse(input.at) + 30 * 86_400_000).toISOString();
  for (const row of remove) {
    const membership = database.prepare("SELECT * FROM workspace_memberships WHERE logical_session_id=?").get(row.id) as { workspace_id: string | null; revision: number } | undefined;
    const operationId = `operation-project-mapping-${randomUUID()}`;
    database.prepare(`INSERT INTO session_tombstones (logical_session_id,operation_id,checkpoint_id,previous_workspace_id,deleted_at,retention_until,restored_at)
      VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(logical_session_id) DO UPDATE SET operation_id=excluded.operation_id,checkpoint_id=excluded.checkpoint_id,
      previous_workspace_id=excluded.previous_workspace_id,deleted_at=excluded.deleted_at,retention_until=excluded.retention_until,restored_at=NULL`)
      .run(row.id, operationId, checkpointId, membership?.workspace_id ?? null, input.at, retentionUntil);
    database.prepare("INSERT INTO codex_project_mapping_removals (logical_session_id,operation_id,policy_revision,workspace_json) VALUES (?,?,?,?) ON CONFLICT(logical_session_id) DO UPDATE SET operation_id=excluded.operation_id,policy_revision=excluded.policy_revision,workspace_json=excluded.workspace_json")
      .run(row.id, operationId, input.revision, membership === undefined ? null : JSON.stringify(membership));
    database.prepare("UPDATE logical_sessions SET tombstoned_at=?,updated_at=? WHERE id=?").run(input.at, input.at, row.id);
    database.prepare("UPDATE workspace_memberships SET workspace_id=NULL,display_order=0,pinned=0,archived=1,revision=revision+1 WHERE logical_session_id=?").run(row.id);
    database.prepare("UPDATE projection_sessions SET mode='hidden' WHERE logical_session_id=?").run(row.id);
  }
  let restored = 0;
  const marked = database.prepare(`SELECT m.logical_session_id,m.workspace_json FROM codex_project_mapping_removals m
    JOIN session_tombstones t ON t.logical_session_id=m.logical_session_id AND t.operation_id=m.operation_id
    JOIN logical_sessions s ON s.id=m.logical_session_id
    WHERE s.tombstoned_at IS NOT NULL AND t.restored_at IS NULL`).all() as unknown as Array<{ logical_session_id: string; workspace_json: string | null }>;
  for (const row of marked) {
    if (!restorable.has(row.logical_session_id)) continue;
    database.prepare("UPDATE logical_sessions SET tombstoned_at=NULL,updated_at=? WHERE id=?").run(input.at, row.logical_session_id);
    database.prepare("UPDATE session_tombstones SET restored_at=? WHERE logical_session_id=?").run(input.at, row.logical_session_id);
    if (row.workspace_json !== null) {
      const membership = JSON.parse(row.workspace_json) as { workspace_id: string | null; display_order: number; pinned: number; archived: number };
      database.prepare("UPDATE workspace_memberships SET workspace_id=?,display_order=?,pinned=?,archived=?,revision=revision+1 WHERE logical_session_id=?")
        .run(membership.workspace_id, membership.display_order, membership.pinned, membership.archived, row.logical_session_id);
    }
    database.prepare("DELETE FROM codex_project_mapping_removals WHERE logical_session_id=?").run(row.logical_session_id);
    restored += 1;
  }
  // Retarget derived/native grouping to the selected root mirror, preserving content.
  const inherited = database.prepare("SELECT child_session_id,parent_session_id FROM session_derivations").all() as unknown as Array<{ child_session_id: string; parent_session_id: string }>;
  const members = new Map((database.prepare("SELECT logical_session_id,project_id FROM project_memberships").all() as unknown as Array<{ logical_session_id: string; project_id: string | null }>).map(row => [row.logical_session_id, row.project_id]));
  const assign = database.prepare(`INSERT INTO project_memberships (logical_session_id,project_id,revision) VALUES (?,?,0)
    ON CONFLICT(logical_session_id) DO UPDATE SET project_id=excluded.project_id,revision=project_memberships.revision+1`);
  for (let pass = 0; pass < inherited.length; pass += 1) {
    let changed = false;
    for (const row of inherited) {
      const parent = members.get(row.parent_session_id);
      if (!keep.has(row.child_session_id) || parent == null || members.get(row.child_session_id) === parent) continue;
      assign.run(row.child_session_id, parent); members.set(row.child_session_id, parent); changed = true;
    }
    if (!changed) break;
  }
  database.prepare(`UPDATE logical_projects SET deleted_at=?,updated_at=? WHERE deleted_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM project_memberships m JOIN logical_sessions s ON s.id=m.logical_session_id WHERE m.project_id=logical_projects.id AND s.tombstoned_at IS NULL)`).run(input.at, input.at);
  database.prepare(`UPDATE logical_projects SET deleted_at=NULL,updated_at=? WHERE deleted_at IS NOT NULL
    AND EXISTS(SELECT 1 FROM project_memberships m JOIN logical_sessions s ON s.id=m.logical_session_id WHERE m.project_id=logical_projects.id AND s.tombstoned_at IS NULL)`).run(input.at);
  return { removed: remove.length, restored, kept: rows.filter(row => keep.has(row.id)).length, checkpointId };
}
