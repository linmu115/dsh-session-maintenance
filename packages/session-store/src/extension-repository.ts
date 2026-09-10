import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ExtensionDataError, extensionListSchema, type ExtensionConnect, type ExtensionScope, type ExtensionWrite,
  type ExtensionObject, type ExtensionMetadata, type ExtensionPage, type ExtensionList, type ExtensionConflict, type ExtensionWriteResult } from "@linmu/dsh-session-contracts";

const where = "instance_id=? AND profile_id=? AND namespace=?";
const key = (s: ExtensionScope) => [s.instanceId, s.profileId, s.namespace];
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
type Row = { instance_id: string; profile_id: string; namespace: string; object_id: string; writer_id: string;
  revision: number; schema_version: number; title: string; deleted: number; updated_at: string; bytes: number; conflicts: number;
  digest?: string; content_json?: string };
export interface ExtensionConnectionRow {
  instance_id: string; profile_id: string; namespace: string; plugin_version: string; writer_id: string;
  configured: number; enabled: number; object_count: number; conflict_count: number; bytes: number;
}
function metadata(row: Row): ExtensionMetadata {
  return { scope: { instanceId: row.instance_id, profileId: row.profile_id, namespace: row.namespace }, objectId: row.object_id,
    writerId: row.writer_id, revision: row.revision, schemaVersion: row.schema_version, title: row.title, deleted: row.deleted === 1,
    updatedAt: row.updated_at, bytes: row.bytes, conflicts: row.conflicts };
}
const columns = "o.instance_id,o.profile_id,o.namespace,o.object_id,o.writer_id,o.revision,o.schema_version,o.title,o.deleted,o.updated_at,o.bytes";
const conflicts = "(SELECT COUNT(*) FROM extension_conflicts c WHERE c.instance_id=o.instance_id AND c.profile_id=o.profile_id AND c.namespace=o.namespace AND c.object_id=o.object_id) AS conflicts";

/** Current state plus unresolved conflicts only. No render, request, or edit snapshots. */
export class SqliteExtensionRepository {
  constructor(private readonly db: DatabaseSync, private readonly clock = () => new Date().toISOString()) {}
  transaction<T>(action: () => T): T {
    this.db.exec("SAVEPOINT extension_write");
    try { const value = action(); this.db.exec("RELEASE extension_write"); return value; }
    catch (error) { this.db.exec("ROLLBACK TO extension_write; RELEASE extension_write"); throw error; }
  }
  connections(): ExtensionConnectionRow[] {
    return this.db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM extension_objects o WHERE o.instance_id=c.instance_id AND o.profile_id=c.profile_id AND o.namespace=c.namespace) object_count,
      (SELECT COUNT(*) FROM extension_conflicts f WHERE f.instance_id=c.instance_id AND f.profile_id=c.profile_id AND f.namespace=c.namespace) conflict_count,
      ((SELECT COALESCE(SUM(bytes),0) FROM extension_objects o WHERE o.instance_id=c.instance_id AND o.profile_id=c.profile_id AND o.namespace=c.namespace)
       + (SELECT COALESCE(SUM(length(CAST(conflict_json AS BLOB))),0) FROM extension_conflicts f WHERE f.instance_id=c.instance_id AND f.profile_id=c.profile_id AND f.namespace=c.namespace)) bytes
      FROM extension_connections c ORDER BY instance_id,profile_id,namespace`).all() as unknown as ExtensionConnectionRow[];
  }
  connect(input: ExtensionConnect): void {
    this.transaction(() => {
      this.db.prepare("UPDATE extension_connections SET configured=0 WHERE instance_id=? AND profile_id=?").run(input.instanceId,input.profileId);
      for (const p of input.plugins) {
        const old = this.db.prepare(`SELECT writer_id FROM extension_connections WHERE ${where}`).get(input.instanceId,input.profileId,p.namespace);
        if (old && old.writer_id !== p.writerId) throw new ExtensionDataError("EXTENSION_WRITER_CONFLICT", "该数据域已由另一个写入方接管。");
        this.db.prepare(`INSERT INTO extension_connections VALUES(?,?,?,?,?,1,1)
          ON CONFLICT(instance_id,profile_id,namespace) DO UPDATE SET plugin_version=excluded.plugin_version,configured=1`)
          .run(input.instanceId,input.profileId,p.namespace,p.pluginVersion,p.writerId);
      }
    });
  }
  enable(scope: ExtensionScope, enabled: boolean): void {
    const result = this.db.prepare(`UPDATE extension_connections SET enabled=? WHERE ${where}`).run(enabled ? 1 : 0,...key(scope));
    if (!result.changes) throw new ExtensionDataError("EXTENSION_NOT_FOUND", "尚未接入此扩展。",404);
  }
  list(input: ExtensionList): ExtensionPage {
    const q = extensionListSchema.parse(input);
    const rows = this.db.prepare(`SELECT ${columns},${conflicts} FROM extension_objects o WHERE ${where}
      AND object_id>? ${q.deleted === "all" ? "" : "AND deleted=" + (q.deleted === "deleted" ? "1" : "0")}
      ORDER BY object_id LIMIT ?`).all(...key(q), q.after ?? "", q.limit+1) as unknown as Row[];
    return { items: rows.slice(0,q.limit).map(metadata), nextCursor: rows.length>q.limit ? rows[q.limit-1]!.object_id : null };
  }
  get(scope: ExtensionScope, objectId: string): ExtensionObject | undefined {
    const row = this.db.prepare(`SELECT o.*,${conflicts} FROM extension_objects o WHERE ${where} AND object_id=?`).get(...key(scope),objectId) as Row | undefined;
    return row ? { ...metadata(row), content: JSON.parse(row.content_json!) } : undefined;
  }
  getConflict(scope: ExtensionScope, id: string): ExtensionConflict | undefined {
    const row = this.db.prepare(`SELECT conflict_json FROM extension_conflicts WHERE ${where} AND id=?`).get(...key(scope),id);
    return row ? JSON.parse(row.conflict_json as string) : undefined;
  }
  conflictIds(scope: ExtensionScope, objectId: string): string[] {
    return (this.db.prepare(`SELECT id FROM extension_conflicts WHERE ${where} AND object_id=? ORDER BY id LIMIT 16`).all(...key(scope),objectId) as {id:string}[]).map(r=>r.id);
  }
  removeConflict(scope: ExtensionScope, id: string): void { this.db.prepare(`DELETE FROM extension_conflicts WHERE ${where} AND id=?`).run(...key(scope),id); }
  write(input: ExtensionWrite): ExtensionWriteResult {
    const body = stable(input.content), bytes = Buffer.byteLength(body);
    if (bytes > 512 * 1024) throw new ExtensionDataError("EXTENSION_TOO_LARGE", "单个扩展对象不能超过 512 KiB。",413);
    return this.transaction(() => {
      const current = this.get(input.scope,input.objectId);
      if (current && current.writerId !== input.writerId) throw new ExtensionDataError("EXTENSION_WRITER_CONFLICT", "对象写入方不匹配。");
      const digest = hash({ content: input.content, deleted: input.deleted });
      if (current && digest === hash({ content: current.content, deleted: current.deleted })) return { status: "unchanged", object: current };
      if ((current?.revision ?? 0) !== input.expectedRevision) {
        if (!current) throw new ExtensionDataError("EXTENSION_REVISION_CONFLICT", "对象不存在，请重新读取。");
        const conflictDigest = hash({ incoming: input, currentRevision: current.revision });
        const previous = this.db.prepare(`SELECT conflict_json FROM extension_conflicts WHERE ${where} AND object_id=? AND digest=?`).get(...key(input.scope),input.objectId,conflictDigest);
        if (previous) return { status: "conflict", conflict: JSON.parse(previous.conflict_json as string) };
        if (current.conflicts >= 16) throw new ExtensionDataError("EXTENSION_CONFLICT_LIMIT", "请先处理此对象已有的冲突；本次编辑仍由调用方保留。");
        const conflict: ExtensionConflict = { id: randomUUID(), objectId: input.objectId, createdAt: this.clock(), expectedRevision: input.expectedRevision, current, incoming: input };
        this.db.prepare("INSERT INTO extension_conflicts VALUES(?,?,?,?,?,?,?)").run(conflict.id,...key(input.scope),input.objectId,conflictDigest,JSON.stringify(conflict));
        return { status: "conflict", conflict };
      }
      if (!current && input.deleted) throw new ExtensionDataError("EXTENSION_NOT_FOUND", "不能删除不存在的对象。",404);
      this.db.prepare(`INSERT INTO extension_objects VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(instance_id,profile_id,namespace,object_id) DO UPDATE SET
        revision=excluded.revision,schema_version=excluded.schema_version,title=excluded.title,deleted=excluded.deleted,
        updated_at=excluded.updated_at,bytes=excluded.bytes,digest=excluded.digest,content_json=excluded.content_json`)
        .run(...key(input.scope),input.objectId,input.writerId,(current?.revision ?? 0)+1,input.content.schemaVersion,input.content.title,input.deleted?1:0,this.clock(),bytes,digest,body);
      return { status: "saved", object: this.get(input.scope,input.objectId)! };
    });
  }
}
