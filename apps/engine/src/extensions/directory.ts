import { createHash } from "node:crypto";
import {
  ExtensionDataError, extensionDirectoryQuerySchema, extensionBusinessPanelQuerySchema,
  type ExtensionDataAdapter, type ExtensionPanel, type ExtensionBusinessPanel, type ExtensionBusinessPanelQuery,
  type ExtensionDirectoryQuery, type ExtensionDirectoryPage, type ExtensionDirectoryObject, type ExtensionDirectoryGroup,
  type ExtensionObjectOwnership, type ExtensionScope,
} from "@linmu/dsh-session-contracts";
import type { SqliteExtensionRepository } from "@linmu/dsh-session-store";

const unbound = "@unbound", ungrouped = "@ungrouped";
const identityJoin = "i.instance_id=o.instance_id AND i.profile_id=o.profile_id AND i.namespace=o.namespace AND i.object_id=o.object_id";
const workspace = `CASE WHEN i.owner_session_id IS NULL OR s.id IS NULL THEN '${unbound}' ELSE COALESCE(p.id,'${ungrouped}') END`;
const owner = `COALESCE(i.owner_session_id,'${unbound}')`;
const distinctBusinessObject = `NOT (i.canonical_reference_id IS NOT NULL AND EXISTS(SELECT 1 FROM extension_objects canonical
  WHERE canonical.instance_id=o.instance_id AND canonical.profile_id=o.profile_id AND canonical.namespace='annotation-upstream'
  AND canonical.object_id=i.canonical_reference_id AND canonical.deleted=0
  AND json_extract(canonical.content_json,'$.body.targetSessionId')=i.owner_session_id))`;
type IndexedRow = { namespace: string; object_id: string; revision: number; schema_version: number };

/** Derived ownership metadata. Body interpretation remains exclusively in trusted Adapters. */
export class ExtensionDirectoryService {
  constructor(private readonly store: SqliteExtensionRepository, private readonly adapters: () => ReadonlyMap<string, ExtensionDataAdapter>,
    private readonly panels: () => ExtensionPanel[]) {}
  invalidate(namespace: string): void {
    this.store.database.prepare("DELETE FROM extension_object_owners WHERE namespace=?").run(namespace);
  }
  private workspaceLabel(id: string, fallback: string): string {
    if (id === unbound || id === ungrouped) return fallback;
    const parts: string[] = [], seen = new Set<string>();
    let current: string | null = id;
    for (let depth = 0; current && depth < 32 && !seen.has(current); depth++) {
      seen.add(current);
      const row = this.store.database.prepare("SELECT name,parent_id FROM logical_workspaces WHERE id=? AND deleted_at IS NULL")
        .get(current) as { name: string; parent_id: string | null } | undefined;
      if (!row) break;
      parts.unshift(row.name.slice(0, 500)); current = row.parent_id;
    }
    return (parts.join(" / ") || fallback).slice(0, 4000);
  }
  businessPanels(input: ExtensionBusinessPanelQuery = {}): ExtensionBusinessPanel[] {
    const query = extensionBusinessPanelQuerySchema.parse(input), grouped = new Map<string, ExtensionBusinessPanel>();
    for (const member of this.panels()) {
      if (query.instanceId && query.instanceId !== member.scope.instanceId || query.profileId && query.profileId !== member.scope.profileId) continue;
      const declared = this.adapters().get(member.scope.namespace)?.panelAdapter;
      const adapterId = declared?.id ?? `namespace:${member.scope.namespace}`;
      const key = JSON.stringify([member.scope.instanceId, member.scope.profileId, adapterId]);
      let panel = grouped.get(key);
      if (!panel) { panel = { adapterId, label: declared?.label ?? member.label,
        scope: { instanceId: member.scope.instanceId, profileId: member.scope.profileId },
        instanceLabel: member.scope.instanceId, profileLabel: member.scope.profileId, status: member.status,
        members: [], objectCount: 0, conflictCount: 0, bytes: 0 }; grouped.set(key, panel); }
      panel.members.push(member); panel.objectCount += member.objectCount; panel.conflictCount += member.conflictCount; panel.bytes += member.bytes;
      if (panel.status !== member.status) panel.status = "partial";
    }
    for (const panel of grouped.values()) {
      const namespaces = panel.members.map(member => member.scope.namespace);
      if (!namespaces.length) { panel.objectCount = 0; continue; }
      this.rebuild(panel.scope, namespaces);
      panel.objectCount = Number(this.store.database.prepare(`SELECT COUNT(*) count FROM extension_objects o
        JOIN extension_object_owners i ON ${identityJoin} WHERE o.instance_id=? AND o.profile_id=?
        AND o.namespace IN (${namespaces.map(() => "?").join(",")}) AND o.deleted=0 AND i.parent_object_id IS NULL AND ${distinctBusinessObject}`)
        .get(panel.scope.instanceId, panel.scope.profileId, ...namespaces)?.count ?? 0);
    }
    return [...grouped.values()].sort((a, b) => JSON.stringify([a.scope, a.adapterId]).localeCompare(JSON.stringify([b.scope, b.adapterId])));
  }
  /** Explicitly rebuildable, with no writes to authoritative content/revision fields. */
  rebuild(scope: { instanceId: string; profileId: string }, namespaces: readonly string[], force = false): void {
    const db = this.store.database;
    this.store.transaction(() => {
      for (const namespace of namespaces) {
        const adapter = this.adapters().get(namespace);
        const version = `ownership-v1:${adapter?.ownership ? adapter.schemaVersions.join(",") : "unknown"}`;
        if (force) db.prepare("DELETE FROM extension_object_owners WHERE instance_id=? AND profile_id=? AND namespace=?").run(scope.instanceId, scope.profileId, namespace);
        db.prepare(`DELETE FROM extension_object_owners AS i WHERE i.instance_id=? AND i.profile_id=? AND i.namespace=?
          AND NOT EXISTS(SELECT 1 FROM extension_objects o WHERE ${identityJoin})`).run(scope.instanceId, scope.profileId, namespace);
        while (true) {
          const rows = db.prepare(`SELECT o.namespace,o.object_id,o.revision,o.schema_version FROM extension_objects o
            LEFT JOIN extension_object_owners i ON ${identityJoin}
            WHERE o.instance_id=? AND o.profile_id=? AND o.namespace=? AND
            (i.object_id IS NULL OR i.object_revision!=o.revision OR i.extractor_version!=?) ORDER BY o.object_id LIMIT 100`)
            .all(scope.instanceId, scope.profileId, namespace, version) as IndexedRow[];
          if (!rows.length) break;
          for (const row of rows) {
            let ownership: ExtensionObjectOwnership = { ownerSessionId: null, kind: "unknown", readOnly: true, reason: "缺少可核验归属的 Adapter" };
            const object = this.store.get({ ...scope, namespace }, row.object_id)!;
            if (adapter?.ownership && adapter.schemaVersions.includes(row.schema_version)) {
              try { adapter.validate(object.content); ownership = adapter.ownership(object.content); }
              catch { ownership = { ownerSessionId: null, kind: "invalid", readOnly: true, reason: "对象格式无法核验，需要兼容的 Adapter" }; }
            }
            db.prepare(`INSERT INTO extension_object_owners VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(instance_id,profile_id,namespace,object_id) DO UPDATE SET
              object_revision=excluded.object_revision,extractor_version=excluded.extractor_version,owner_session_id=excluded.owner_session_id,
              object_kind=excluded.object_kind,parent_object_id=excluded.parent_object_id,read_only=excluded.read_only,
              ownership_reason=excluded.ownership_reason,canonical_reference_id=excluded.canonical_reference_id`)
              .run(scope.instanceId, scope.profileId, namespace, row.object_id, row.revision, version, ownership.ownerSessionId,
                ownership.kind, ownership.parentObjectId ?? null, ownership.readOnly ? 1 : 0, ownership.reason ?? null, ownership.canonicalReferenceId ?? null);
          }
        }
      }
    });
  }
  list(input: ExtensionDirectoryQuery): ExtensionDirectoryPage {
    const q = extensionDirectoryQuerySchema.parse(input);
    const business = this.businessPanels(q.instanceId ? { instanceId: q.instanceId, profileId: q.profileId } : {})
      .find(panel => panel.adapterId === q.adapterId);
    if (!business) throw new ExtensionDataError("EXTENSION_NOT_FOUND", "该实例未接入此业务 Adapter。", 404);
    const namespaces = business.members.map(panel => panel.scope.namespace);
    if (!namespaces.length) return { level: q.level, items: [], nextCursor: null };
    this.rebuild(q, namespaces);
    const params: Array<string | number> = [q.instanceId, q.profileId, ...namespaces];
    const join = `FROM extension_objects o JOIN extension_object_owners i ON ${identityJoin}
      LEFT JOIN logical_sessions s ON s.id=i.owner_session_id
      LEFT JOIN workspace_memberships m ON m.logical_session_id=s.id LEFT JOIN logical_workspaces p ON p.id=m.workspace_id AND p.deleted_at IS NULL`;
    let where = `WHERE o.instance_id=? AND o.profile_id=? AND o.namespace IN (${namespaces.map(() => "?").join(",")})`;
    if (q.deleted !== "all") { where += " AND o.deleted=?"; params.push(q.deleted === "deleted" ? 1 : 0); }
    // A lightweight Core mirror does not create a second row for the same authoritative upstream relation.
    where += ` AND ${distinctBusinessObject}`;
    if (q.parentObjectId) { where += " AND i.parent_object_id=?"; params.push(q.parentObjectId); }
    else where += " AND i.parent_object_id IS NULL";
    if (q.level === "objects" && q.workspaceId) { where += ` AND ${workspace}=?`; params.push(q.workspaceId); }
    const cursorBinding = createHash("sha256").update(JSON.stringify({ ...q, after: undefined, limit: undefined })).digest("hex");
    let after = "";
    if (q.after) {
      try {
        const cursor = JSON.parse(Buffer.from(q.after, "base64url").toString());
        if (cursor.binding !== cursorBinding || typeof cursor.after !== "string") throw new Error();
        after = cursor.after;
      } catch { throw new ExtensionDataError("EXTENSION_CURSOR_INVALID", "目录游标不属于当前筛选条件。", 400); }
    }
    let items: Array<ExtensionDirectoryGroup | ExtensionDirectoryObject>;
    const db = this.store.database;
    if (q.level === "workspaces") {
      const rows = db.prepare(`SELECT ${workspace} id,CASE WHEN ${workspace}='${unbound}' THEN '待绑定 / 待核验'
        ELSE COALESCE(p.name,'未分组') END label,COUNT(*) count,
        MAX(CASE WHEN s.archived_at IS NOT NULL OR s.archived=1 THEN 1 ELSE 0 END) archived,
        MAX(s.archived_at) archivedAt,MAX(CASE WHEN i.owner_session_id IS NOT NULL AND s.id IS NULL THEN 1 ELSE 0 END) missing
        ${join} ${where} AND ${workspace}>? GROUP BY ${workspace} ORDER BY id LIMIT ?`)
        .all(...params, after, q.limit + 1) as Array<{ id: string; label: string; count: number; archived: number; archivedAt: string | null; missing: number }>;
      items = rows.map(row => ({ ...row, type: "workspace", label: this.workspaceLabel(row.id, row.label), archived: false, archivedAt: null, missing: Boolean(row.missing) }));
    } else if (q.level === "sessions") {
      const rows = db.prepare(`SELECT ${owner} id,COALESCE(s.display_title,CASE WHEN i.owner_session_id IS NULL THEN '待绑定对象' ELSE '所属会话不可用' END) label,
        i.owner_session_id ownerSessionId,COUNT(*) count,MAX(CASE WHEN s.archived_at IS NOT NULL OR s.archived=1 OR m.archived=1 THEN 1 ELSE 0 END) archived,
        MAX(s.archived_at) archivedAt,MAX(CASE WHEN i.owner_session_id IS NOT NULL AND (s.id IS NULL OR s.tombstoned_at IS NOT NULL) THEN 1 ELSE 0 END) missing
        ${join} ${where} AND ${workspace}=? AND ${owner}>? GROUP BY ${owner} ORDER BY id LIMIT ?`)
        .all(...params, q.workspaceId!, after, q.limit + 1) as Array<{ id: string; label: string; ownerSessionId: string | null; count: number; archived: number; archivedAt: string | null; missing: number }>;
      items = rows.map(row => ({ ...row, type: "session", archived: Boolean(row.archived), missing: Boolean(row.missing) }));
    } else {
      type Row = { namespace: string; object_id: string; owner_session_id: string | null; object_kind: string; parent_object_id: string | null;
        read_only: number; ownership_reason: string | null; archived_at: string | null; archived: number; membership_archived: number; tombstoned_at: string | null; session_id: string | null; children: number };
      const rows = db.prepare(`SELECT i.*,s.archived_at,s.archived,m.archived membership_archived,s.tombstoned_at,s.id session_id,
        (SELECT COUNT(*) FROM extension_object_owners child JOIN extension_objects co ON co.instance_id=child.instance_id AND co.profile_id=child.profile_id
          AND co.namespace=child.namespace AND co.object_id=child.object_id WHERE child.instance_id=i.instance_id AND child.profile_id=i.profile_id
          AND child.namespace=i.namespace AND child.parent_object_id=i.object_id AND co.deleted=0) children
        ${join} ${where} AND ${owner}=? AND (o.namespace || '/' || o.object_id)>? ORDER BY (o.namespace || '/' || o.object_id) LIMIT ?`)
        .all(...params, q.ownerSessionId!, after, q.limit + 1) as Row[];
      items = rows.map(row => {
        const metadata = this.store.getMetadata({ instanceId: q.instanceId, profileId: q.profileId, namespace: row.namespace }, row.object_id)!;
        const panel = business.members.find(member => member.scope.namespace === row.namespace)!;
        const archived = Boolean(row.archived_at || row.archived || row.membership_archived), missing = Boolean(row.owner_session_id && (!row.session_id || row.tombstoned_at));
        return { ...metadata, type: "object", id: `${row.namespace}/${row.object_id}`, label: metadata.title, count: row.children,
          ownerSessionId: row.owner_session_id, kind: row.object_kind, parentObjectId: row.parent_object_id,
          readOnly: Boolean(row.read_only || archived || missing || panel.status !== "ready" || !panel.capabilities?.write),
          unavailableReason: panel.status !== "ready" ? `${panel.label}：${{disabled:"已停用", "missing-adapter":"缺少适配器", incompatible:"版本不兼容"}[panel.status]}` : missing ? "所属会话不可用" : null,
          ownershipReason: row.ownership_reason, archived, archivedAt: row.archived_at, missing };
      });
    }
    const page = items.slice(0, q.limit);
    return { level: q.level, items: page, nextCursor: items.length > q.limit
      ? Buffer.from(JSON.stringify({ binding: cursorBinding, after: page.at(-1)!.id })).toString("base64url") : null };
  }
}
