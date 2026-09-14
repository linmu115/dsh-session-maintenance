import { z } from "zod";
import {
  ExtensionDataError, graphResolveSchema, sessionContextRecordSchema, sessionStickerSchema,
  type GraphResolve, type GraphSessionIdentity, type GraphPreviewPage, type GraphPreviewSelection,
  type GraphRelationPage, type SessionContextDirectory, type RunId, type LogicalSessionId, type NativeSessionId, type SessionVersionId, type JsonValue,
  type GraphSave, type GraphRemove, type GraphBind, type SessionContextRecord, type GraphDisclosureInput, type GraphSourceMarkerPage,
} from "@linmu/dsh-session-contracts";
import { JsonProjectionDirectory, projectionRootFor } from "@linmu/dsh-session-projection-lifecycle";
import type { SessionMaintenanceEngine } from "./engine.js";
import { SessionGraphStore, graphObjectId } from "./session-graph-store.js";

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
  private graphStore?: SessionGraphStore;
  private get graphs() { return this.graphStore ??= new SessionGraphStore(this.engine.repository.database); }
  private async graphAccess(runId: string, optional = false) {
    const run = await this.run(runId);
    const panel = this.engine.extensions?.panels().find(p => p.scope.instanceId === run.instanceId && p.scope.profileId === run.profileId && p.scope.namespace === "thoughtdag");
    if (!panel || panel.status !== "ready") {
      if (optional) return null;
      throw unavailable("当前实例未启用匹配的 ThoughtDAG 图适配器；已保存数据保留");
    }
    return { scope: panel.scope, writerId: panel.writerId };
  }
  async ensure(runId: string, logicalSessionId: string) {
    const a = (await this.graphAccess(runId))!, target = await this.resolve(runId, { logicalSessionId });
    return this.graphs.ensure(a.scope, a.writerId, target.logicalSessionId, target.title);
  }
  async load(runId: string, objectId: string) {
    const a = (await this.graphAccess(runId))!, doc = this.graphs.load(a.scope, objectId);
    if (doc.graph.ownerSessionId) await this.resolve(runId, { logicalSessionId: doc.graph.ownerSessionId });
    return doc;
  }
  async save(runId: string, input: GraphSave) {
    const a = (await this.graphAccess(runId))!;
    if (input.graph.ownerSessionId) await this.resolve(runId, { logicalSessionId: input.graph.ownerSessionId });
    for (const logicalSessionId of new Set(input.graph.nodes.flatMap(n => n.data.logicalSessionId ? [n.data.logicalSessionId] : [])))
      await this.resolve(runId, { logicalSessionId });
    return this.graphs.save(a.scope, a.writerId, input);
  }
  async bind(runId: string, input: GraphBind) {
    const a = (await this.graphAccess(runId))!, target = await this.resolve(runId, { logicalSessionId: input.logicalSessionId });
    return this.graphs.bind(a.scope, a.writerId, input.objectId, input.expectedRevision, target.logicalSessionId, target.title);
  }
  async remove(runId: string, input: GraphRemove) {
    const a = (await this.graphAccess(runId))!;
    await this.load(runId, input.objectId);
    return this.graphs.remove(a.scope, a.writerId, input);
  }
  async syncReference(runId: string, record: SessionContextRecord) {
    const a = await this.graphAccess(runId, true); if (!a) return null;
    const target = await this.resolve(runId, { logicalSessionId: record.targetSessionId });
    return this.graphs.syncReference(a.scope, a.writerId, record, record.sourceTitle, target.title);
  }
  async appendDisclosure(runId: string, record: SessionContextRecord, input: GraphDisclosureInput) {
    const a = await this.graphAccess(runId, true); if (!a) return null;
    if (!this.graphs.store.get(a.scope, graphObjectId(record.targetSessionId))) {
      const target = await this.resolve(runId, { logicalSessionId: record.targetSessionId });
      this.graphs.syncReference(a.scope, a.writerId, record, record.sourceTitle, target.title);
    }
    return this.graphs.appendDisclosure(a.scope, a.writerId, record, input);
  }
  async settleDisclosure(runId: string, record: SessionContextRecord, requestId: string, delivery: "returned" | "failed") {
    const a = await this.graphAccess(runId, true); if (!a) return;
    this.graphs.settleDisclosure(a.scope, a.writerId, record, requestId, delivery);
  }
  async disclosures(runId: string, objectId: string, after?: string) {
    const a = (await this.graphAccess(runId))!, doc = await this.load(runId, objectId);
    if (!doc.graph.ownerSessionId) return { items: [], nextCursor: null, trimmed: false, trimmedCount: 0,
      maxEntries: this.graphs.maxEntries, maxBytes: this.graphs.maxBytes, coverage: [], coverageTruncated: false };
    return this.graphs.disclosures(a.scope, doc.graph.ownerSessionId, after);
  }
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
    if (!snapshot?.headVersionId) throw unavailable("会话尚无已登记回复");
    let q: PreviewCursor;
    try { q = cursor ? cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")))
      : { run: runId, session: logicalSessionId, version: selection?.sourceVersionId ?? snapshot.headVersionId,
        before: null, anchor: selection?.sourceAnchorId ?? null, entry: 0, offset: 0 }; }
    catch { throw unavailable("预览游标无效，请重新展开节点"); }
    if (q.run !== runId || q.session !== logicalSessionId) throw unavailable("预览游标不属于当前会话");
    const version = await this.engine.canonicalEngine.store.getVersion(q.version as SessionVersionId)
      .catch(()=>{throw unavailable("固定来源版本已清理或不可用；不会换用最新上下文");});
    if (!version || version.logicalSessionId !== logicalSessionId) throw unavailable("固定来源版本已清理或不可用；不会换用最新上下文");
    const versionAdapter = this.engine.resolveProjectionAdapter(run.adapterId);
    const adapter = versionAdapter?.sessionGraph;
    if (!adapter) throw unavailable("当前版本 Adapter 未提供画布预览");
    const events = await this.engine.projectionSourceFor(run.adapterId).loadVersionEvents?.(logicalSessionId as LogicalSessionId, version.id)
      .catch(()=>{throw unavailable("固定来源正文已清理或不可用；不会换用最新上下文");});
    if (!events || events.length !== version.events.length || events.some((e, i) => e.id !== version.events[i]!.id))
      throw unavailable("来源格式读取改变了原始事件身份");
    let projection: JsonValue;
    if (version.id === snapshot.headVersionId) projection = await new JsonProjectionDirectory(projectionRootFor(this.engine.projectionRuntimeRoot, run.id))
      .readSession(identity.nativeSessionId as NativeSessionId);
    else {
      // Ask the version Adapter to reconstruct only this retained version in memory.
      // The live projection may contain a newer conversion ledger and is never rewritten.
      let retained: JsonValue | undefined;
      await versionAdapter!.materialize({run,workspaces:[],sessions:[{
        session:{...snapshot.session,headVersionId:version.id},events,workspaceId:null,
      }]},{writeWorkspace:async()=>{},writeSession:async(_id,value)=>{if(retained!==undefined)throw unavailable("固定来源产生多个会话");retained=value;}})
        .catch(()=>{throw unavailable("固定来源版本无法转换为可读格式；不会换用最新上下文");});
      if(retained===undefined)throw unavailable("固定来源版本无法转换为可读格式");
      projection=retained;
    }
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
    const retained = await this.engine.canonicalEngine.store.getVersion(version.id)
      .catch(()=>{throw unavailable("固定来源版本已清理或不可用");});
    if(!retained||retained.logicalSessionId!==logicalSessionId)throw unavailable("固定来源版本已清理或不可用");
    return page;
  }
  async relations(runId: string, logicalSessionId: string, after = ""): Promise<GraphRelationPage> {
    await this.resolve(runId, { logicalSessionId });
    const run = await this.run(runId), db = this.engine.repository.database;
    const rows = db.prepare(`SELECT object_id,revision,content_json FROM extension_objects o
      WHERE o.instance_id=? AND o.profile_id=? AND o.namespace='annotation-upstream' AND o.deleted=0 AND o.object_id>?
      AND json_extract(o.content_json,'$.body.targetSessionId')=?
      AND EXISTS (SELECT 1 FROM projection_sessions ps JOIN logical_sessions s ON s.id=ps.logical_session_id
        WHERE ps.run_id=? AND ${visible} AND ps.logical_session_id=json_extract(o.content_json,'$.body.sourceSessionId'))
      AND EXISTS (SELECT 1 FROM projection_sessions ps JOIN logical_sessions s ON s.id=ps.logical_session_id
        WHERE ps.run_id=? AND ${visible} AND ps.logical_session_id=json_extract(o.content_json,'$.body.targetSessionId'))
      ORDER BY object_id LIMIT 31`).all(run.instanceId, run.profileId, after, logicalSessionId, runId, runId) as unknown as
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
  async sourceMarkers(runId: string, nativeSessionId: string, after = ""): Promise<GraphSourceMarkerPage> {
    const run = await this.run(runId), source = await this.resolve(runId, { nativeSessionId });
    const rows = this.engine.repository.database.prepare(`SELECT o.object_id,o.content_json,s.display_title title,
      (SELECT st.content_json FROM extension_objects st WHERE st.instance_id=o.instance_id AND st.profile_id=o.profile_id
        AND st.namespace='stickers' AND st.deleted=0 AND json_extract(st.content_json,'$.body.source.referenceId')=o.object_id
        ORDER BY st.object_id LIMIT 1) sticker_json
      FROM extension_objects o JOIN logical_sessions s ON s.id=json_extract(o.content_json,'$.body.targetSessionId')
      WHERE o.instance_id=? AND o.profile_id=? AND o.namespace='annotation-upstream' AND o.deleted=0 AND o.object_id>?
      AND json_extract(o.content_json,'$.body.sourceSessionId')=? AND json_extract(o.content_json,'$.body.state') IN ('pending','sent')
      AND s.tombstoned_at IS NULL AND EXISTS(SELECT 1 FROM projection_sessions ps WHERE ps.run_id=? AND ps.logical_session_id=s.id
        AND ps.mode NOT IN ('hidden','recovery-only')) ORDER BY o.object_id LIMIT 31`)
      .all(run.instanceId, run.profileId, after, source.logicalSessionId, runId) as unknown as Array<{object_id:string;content_json:string;title:string;sticker_json:string|null}>;
    return { items: rows.slice(0, 30).flatMap(row => {
      const parsed = sessionContextRecordSchema.safeParse(JSON.parse(row.content_json).body); if (!parsed.success) return [];
      const r = parsed.data;
      const sticker = row.sticker_json ? sessionStickerSchema.safeParse(JSON.parse(row.sticker_json).body) : null;
      const locator = sticker?.success && sticker.data.logicalSessionId === r.targetSessionId &&
        sticker.data.source?.logicalSessionId === r.sourceSessionId && sticker.data.source.sourceVersionId === r.sourceVersionId &&
        sticker.data.source.sourceAnchorId === r.sourceAnchorId ? sticker.data.source.locator : undefined;
      return [{ objectId: row.object_id, referenceId: r.referenceId, sourceVersionId: r.sourceVersionId, sourceAnchorId: r.sourceAnchorId,
        messageId: locator?.messageId ?? r.sourceAnchorId, selectedText: locator?.selectedText ?? r.selectedText,
        occurrence: locator?.occurrence ?? 0, targetLogicalSessionId: r.targetSessionId, targetTitle: row.title.slice(0,500) }];
    }), nextCursor: rows.length > 30 ? rows[29]!.object_id : null };
  }
}
