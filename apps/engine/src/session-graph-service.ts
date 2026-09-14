import { z } from "zod";
import {
  ExtensionDataError, graphResolveSchema, sessionContextRecordSchema,
  type GraphResolve, type GraphSessionIdentity, type GraphPreviewPage, type GraphPreviewSelection,
  type GraphRelationPage, type SessionContextDirectory, type RunId, type LogicalSessionId, type NativeSessionId,
} from "@linmu/dsh-session-contracts";
import { JsonProjectionDirectory, projectionRootFor } from "@linmu/dsh-session-projection-lifecycle";
import type { SessionMaintenanceEngine } from "./engine.js";

const unavailable = (message: string) => new ExtensionDataError("GRAPH_UNAVAILABLE", message, 409);
const cursorSchema = z.strictObject({
  run: z.string().max(256), session: z.string().max(256), version: z.string().max(256),
  before: z.string().max(256).nullable(), anchor: z.string().max(256).nullable(),
  entry: z.number().int().min(0).max(1000000), offset: z.number().int().min(0).max(1000000000),
});
type PreviewCursor = z.infer<typeof cursorSchema>;
const encode = (value: PreviewCursor) => Buffer.from(JSON.stringify(value)).toString("base64url");
const pageBytes = 16000;
const visible = "ps.mode NOT IN ('hidden','recovery-only') AND s.tombstoned_at IS NULL";

/** Graph navigation is independent of Annotation availability; reads create no objects. */
export class SessionGraphService {
  constructor(private readonly engine: SessionMaintenanceEngine) {}
  private async run(runId: string) {
    const run = await this.engine.projectionRunRepository.getProjectionRun(runId as RunId);
    if (!run || run.state !== "running") throw unavailable("当前实例的会话空间尚未就绪");
    return run;
  }
  async resolve(runId: string, input: GraphResolve): Promise<GraphSessionIdentity> {
    await this.run(runId);
    const q = graphResolveSchema.parse(input);
    const rows = this.engine.repository.database.prepare(`SELECT ps.logical_session_id logicalSessionId,
      ps.native_session_id nativeSessionId,s.display_title title FROM projection_sessions ps
      JOIN logical_sessions s ON s.id=ps.logical_session_id WHERE ps.run_id=? AND ${visible}
      AND ${"logicalSessionId" in q ? "ps.logical_session_id" : "ps.native_session_id"}=? LIMIT 2`)
      .all(runId, "logicalSessionId" in q ? q.logicalSessionId : q.nativeSessionId) as unknown as GraphSessionIdentity[];
    if (rows.length === 0) throw new ExtensionDataError("GRAPH_SESSION_NOT_FOUND", "会话未接入当前实例或已删除", 409);
    if (rows.length !== 1) throw new ExtensionDataError("GRAPH_IDENTITY_AMBIGUOUS", "当前实例中的会话身份不唯一", 409);
    return { ...rows[0]!, title: rows[0]!.title.slice(0, 500) };
  }
  async directory(runId: string, workspaceId?: string, after = ""): Promise<SessionContextDirectory> {
    await this.run(runId);
    const join = `FROM projection_sessions ps JOIN logical_sessions s ON s.id=ps.logical_session_id
      LEFT JOIN project_memberships m ON m.logical_session_id=s.id LEFT JOIN logical_projects w ON w.id=m.project_id AND w.deleted_at IS NULL
      WHERE ps.run_id=? AND ${visible}`;
    const db = this.engine.repository.database;
    const rows = workspaceId === undefined
      ? db.prepare(`SELECT DISTINCT COALESCE(w.id,'@ungrouped') id,COALESCE(w.name,'未分组') title ${join}
          AND COALESCE(w.id,'@ungrouped')>? ORDER BY id LIMIT 51`).all(runId, after)
      : db.prepare(`SELECT DISTINCT ps.native_session_id id,s.display_title title,s.id logicalSessionId ${join}
          AND COALESCE(w.id,'@ungrouped')=? AND ps.native_session_id>? ORDER BY id LIMIT 51`).all(runId, workspaceId, after);
    const items = rows as unknown as SessionContextDirectory["items"];
    return { items: items.slice(0, 50).map(item => ({ ...item, title: item.title.slice(0, 500) })),
      nextCursor: items.length > 50 ? items[49]!.id : null };
  }
  async preview(runId: string, logicalSessionId: string, cursor?: string, selection?: GraphPreviewSelection): Promise<GraphPreviewPage> {
    const run = await this.run(runId), identity = await this.resolve(runId, { logicalSessionId });
    if (cursor && selection) throw unavailable("继续读取不能同时更改预览来源");
    const snapshot = await this.engine.canonicalEngine.store.getSession(logicalSessionId as LogicalSessionId);
    const version = snapshot?.headVersionId ? await this.engine.canonicalEngine.store.getVersion(snapshot.headVersionId) : undefined;
    if (!version) throw unavailable("会话尚无已登记回复");
    let q: PreviewCursor;
    try { q = cursor ? cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")))
      : { run: runId, session: logicalSessionId, version: selection?.sourceVersionId ?? version.id,
        before: null, anchor: selection?.sourceAnchorId ?? null, entry: 0, offset: 0 }; }
    catch { throw unavailable("预览游标无效，请重新展开节点"); }
    if (q.run !== runId || q.session !== logicalSessionId || q.version !== version.id)
      throw unavailable("来源版本已改变，请重新选择回复；不会自动换用最新上下文");
    const adapter = this.engine.resolveProjectionAdapter(run.adapterId)?.sessionGraph;
    if (!adapter) throw unavailable("当前版本 Adapter 未提供画布预览");
    const events = await this.engine.projectionSourceFor(run.adapterId).loadVersionEvents?.(logicalSessionId as LogicalSessionId, version.id);
    if (!events || events.length !== version.events.length || events.some((e, i) => e.id !== version.events[i]!.id))
      throw unavailable("来源格式读取改变了原始事件身份");
    const projection = await new JsonProjectionDirectory(projectionRootFor(this.engine.projectionRuntimeRoot, run.id))
      .readSession(identity.nativeSessionId as NativeSessionId);
    let turn;
    try { turn = adapter.completedTurn(events, projection, q.before ?? undefined, q.anchor ?? undefined); }
    catch (error) { throw unavailable(error instanceof Error ? error.message : "无法确认完整回复"); }
    if (!turn || turn.selectedText.length === 0) throw unavailable("没有可读取的完整回复，或所选回复已不可用");
    const selectedText = [...turn.selectedText].slice(0, 512).join("");
    const page: GraphPreviewPage = { ...identity, sourceVersionId: version.id, items: [],
      capture: { sourceSessionId: identity.nativeSessionId, anchorId: turn.anchorId, messageId: turn.messageId,
        role: "assistant", occurrence: 0, selectedText }, nextCursor: null, hasMore: false };
    if (q.entry >= turn.entries.length || q.offset > turn.entries[q.entry]!.text.length)
      throw unavailable("预览游标位置无效");
    // Reserve all identity/capture/cursor JSON bytes before admitting any text.
    const reservedCursor = encode({ ...q, before: turn.cutoffEventId, entry: 1000000, offset: 1000000000 });
    let remaining = pageBytes - Buffer.byteLength(JSON.stringify({ ...page, nextCursor: reservedCursor })) - 512;
    let index = q.entry, offset = q.offset;
    while (index < turn.entries.length && remaining > 200) {
      const entry = turn.entries[index]!;
      let low = 0, high = entry.text.length - offset;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const item = { ...entry, text: entry.text.slice(offset, offset + mid), offset, complete: false };
        if (Buffer.byteLength(JSON.stringify(item)) + 1 <= remaining) low = mid; else high = mid - 1;
      }
      // Keep UTF-16 surrogate pairs intact across pages.
      if (low > 0 && /[\uD800-\uDBFF]/u.test(entry.text[offset + low - 1]!)) low--;
      if (!low && offset < entry.text.length) break;
      const item = { ...entry, text: entry.text.slice(offset, offset + low), offset, complete: offset + low === entry.text.length };
      page.items.push(item); remaining -= Buffer.byteLength(JSON.stringify(item)) + 1;
      offset += low;
      if (offset < entry.text.length) break;
      index++; offset = 0;
    }
    if (index < turn.entries.length) page.nextCursor = encode({ ...q, entry: index, offset });
    else if (adapter.completedTurn(events, projection, turn.cutoffEventId))
      page.nextCursor = encode({ ...q, before: turn.cutoffEventId, anchor: null, entry: 0, offset: 0 });
    page.hasMore = page.nextCursor !== null;
    if (page.items.length === 0 || Buffer.byteLength(JSON.stringify(page)) > pageBytes) throw unavailable("预览身份过长，无法在本次额度内读取");
    // A concurrent append or delete cannot silently turn this result into another source.
    await this.resolve(runId, { logicalSessionId });
    const latest = await this.engine.canonicalEngine.store.getSession(logicalSessionId as LogicalSessionId);
    if (latest?.headVersionId !== version.id) throw unavailable("来源在读取期间已变化，请重新展开节点");
    return page;
  }
  async relations(runId: string, after = ""): Promise<GraphRelationPage> {
    const run = await this.run(runId), db = this.engine.repository.database;
    const rows = db.prepare(`SELECT object_id,revision,content_json FROM extension_objects o
      WHERE o.instance_id=? AND o.profile_id=? AND o.namespace='annotation-upstream' AND o.deleted=0 AND o.object_id>?
      AND EXISTS (SELECT 1 FROM projection_sessions ps JOIN logical_sessions s ON s.id=ps.logical_session_id
        WHERE ps.run_id=? AND ${visible} AND ps.logical_session_id=json_extract(o.content_json,'$.body.sourceSessionId'))
      AND EXISTS (SELECT 1 FROM projection_sessions ps JOIN logical_sessions s ON s.id=ps.logical_session_id
        WHERE ps.run_id=? AND ${visible} AND ps.logical_session_id=json_extract(o.content_json,'$.body.targetSessionId'))
      ORDER BY object_id LIMIT 31`).all(run.instanceId, run.profileId, after, runId, runId) as unknown as
      Array<{ object_id: string; revision: number; content_json: string }>;
    const items: GraphRelationPage["items"] = rows.slice(0, 30).flatMap(row => {
      const parsed = sessionContextRecordSchema.safeParse(JSON.parse(row.content_json).body);
      if (!parsed.success) return [];
      const { referenceId, sourceSessionId, targetSessionId, sourceVersionId, cutoffEventId, sourceAnchorId, state, targetMessageId } = parsed.data;
      return [{ namespace: "annotation-upstream", objectId: row.object_id, revision: row.revision, referenceId,
        sourceSessionId, targetSessionId, sourceVersionId, cutoffEventId, sourceAnchorId, state, targetMessageId }];
    });
    return { items, nextCursor: rows.length > 30 ? rows[29]!.object_id : null };
  }
}
