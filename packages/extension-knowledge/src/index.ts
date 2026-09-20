import { gptCompatExtensionAdapter } from "@linmu/dsh-session-extension-gpt-compat";
import { z } from "zod";
import { ANNOTATION_RECORDS_NAMESPACE, annotationMirrorRecordSchema, NATIVE_CONTEXT_NAMESPACE, nativeContextStateSchema } from "@linmu/dsh-session-contracts";
import { ExtensionDataError, sessionContextRecordSchema, SESSION_CONTEXT_NAMESPACE, managedGraphSchema, legacyManagedGraphSchema, graphDisclosureLogSchema, stickerObjectSchema, knowledgeLinkSchema, type ExtensionDataAdapter } from "@linmu/dsh-session-contracts";

const id = z.string().min(1);
const capabilities = { read:true,write:true,delete:true,restore:true,panel:true,context:false } as const;
const obsidianPanel = { id: "obsidian-series", label: "Obsidian 系列" };
const mirrorState = { pending: "待发送", committing: "提交中", sent: "已发送", failed: "发送失败", deleted: "已删除" } as const;
// Preserve upstream fields; validate the structural contract without translating
// graph edges into session events or duplicating native session content.
const canvas = z.object({
  nodes: z.array(z.object({ id, position: z.object({ x: z.number().finite(), y: z.number().finite() }), data: z.record(z.string(),z.unknown()) }).passthrough()).max(10000),
  edges: z.array(z.object({ id, source: id, target: id }).passthrough()).max(20000),
}).passthrough();
const referenceSet = z.object({
  schemaVersion: z.literal(1), setId: id, profileId: id, sessionId: id,
  state: z.enum(["pending","committing","sent","failed"]), revision: z.number().int().nonnegative(), createdAt: z.number().finite(),
  items: z.array(z.object({ referenceId: id, number: z.number().int().positive(), selectedText: z.string(), userComment: z.string(),
    backlinkState: z.enum(["not-required","pending","written","failed"]), sourceType: z.enum(["dsh-message","obsidian-note","extension"]),
    locator: z.record(z.string(),z.unknown()) }).passthrough()).max(1000),
}).passthrough();
function unique(ids: string[]): void {
  if (new Set(ids).size !== ids.length) throw new ExtensionDataError("EXTENSION_INVALID_OBJECT", "对象中存在重复身份。",422);
}
const sessionGraphReplica = z.strictObject({
  sessionId: id, namespace: z.literal('thoughtdag'), objectId: id,
  revision: z.number().int().positive(), deleted: z.boolean(),
  content: z.strictObject({ title: z.string().max(500), graph: managedGraphSchema }),
});
function unwrapSessionGraph(body: import('@linmu/dsh-session-contracts').JsonValue) {
  const parsed = sessionGraphReplica.safeParse(body);
  return parsed.success ? parsed.data.content.graph as import('@linmu/dsh-session-contracts').JsonValue : body;
}
export const thoughtDagAdapter: ExtensionDataAdapter = {
  capabilities,
  panelAdapter: { id: "thoughtdag", label: "ThoughtDAG" },
  ownership(content) {
    if (content.schemaVersion === 3) { const value = sessionGraphReplica.parse(content.body); return { ownerSessionId: value.sessionId, kind: "graph", readOnly: true }; }
    const log = graphDisclosureLogSchema.safeParse(content.body);
    if (log.success) return { ownerSessionId: log.data.ownerSessionId, kind: "disclosure-log", parentObjectId: log.data.graphObjectId, readOnly: true };
    const graph = managedGraphSchema.safeParse(content.body);
    return graph.success ? { ownerSessionId: graph.data.ownerSessionId, kind: "graph", readOnly: true, reason: graph.data.ownerSessionId ? null : "待绑定主干会话" }
      : { ownerSessionId: null, kind: "legacy-graph", readOnly: true, reason: "旧图需要核验归属；不会把关联会话当作所有者" };
  },
  namespace: "thoughtdag", label: "ThoughtDAG", pluginVersions: ["0.4.11", "0.4.14-rc2.1", "0.4.14-rc2.2", "0.4.14-rc2.3", "0.4.14-rc2.4", "0.4.14-rc2.5", "0.4.14-rc2.6", "0.4.14-rc2.7", "0.4.14-rc2.8","0.4.14-rc2.9","0.4.14-rc2.10","0.4.14-rc2.11","0.4.14-rc2.12","0.4.14-rc2.13","0.4.14-rc2.14", "0.4.14-rc2.15", "0.4.14-rc2.16", "0.4.14-rc2.17"], schemaVersions: [1, 2, 3],
  validate(content) {
    if (content.schemaVersion === 3) {
      const value = sessionGraphReplica.parse(content.body);
      if (value.sessionId !== value.content.graph.ownerSessionId) throw new ExtensionDataError("EXTENSION_INVALID_OBJECT", "Graph owner differs from session", 422);
      return;
    }
    if (content.schemaVersion === 2 && typeof content.body === "object" && content.body !== null && "kind" in content.body && content.body.kind === "disclosure-log") {
      const log = graphDisclosureLogSchema.parse(content.body); unique(log.items.map(item => item.receiptId));
      if (Buffer.byteLength(JSON.stringify(content.body)) > 262144) throw new ExtensionDataError("EXTENSION_TOO_LARGE", "读取记录超过容量上限", 413);
      if (log.items.some(item => item.targetSessionId !== log.ownerSessionId)) throw new ExtensionDataError("EXTENSION_INVALID_OBJECT", "读取记录不属于当前主干", 422);
      return;
    }
    if (content.schemaVersion === 2) managedGraphSchema.parse(content.body);
    else if (typeof content.body === "object" && content.body !== null && !Array.isArray(content.body) && "managedSchema" in content.body)
      legacyManagedGraphSchema.parse(content.body);
    const result = canvas.parse(content.body); unique(result.nodes.map(n=>n.id)); unique(result.edges.map(e=>e.id));
    const ids = new Set(result.nodes.map(n=>n.id));
    if (result.edges.some(e=>!ids.has(e.source)||!ids.has(e.target))) throw new ExtensionDataError("EXTENSION_INVALID_OBJECT", "画布连线引用了不存在的节点。",422);
  },
  summarize(body) {
    body = unwrapSessionGraph(body);
    const log = graphDisclosureLogSchema.safeParse(body);
    if (log.success) return `${log.data.items.length} 条读取位置${log.data.trimmed ? " · 早期记录已裁剪" : ""}`;
    const value = canvas.parse(body); const graph = managedGraphSchema.safeParse(body);
    return `${graph.success ? `${graph.data.archivedAt ? "已随会话归档 · " : ""}主干 ${graph.data.ownerSessionId ?? "待绑定"} · ` : "旧图待核验 · "}${value.nodes.length} 个节点 · ${value.edges.length} 条连线`;
  },
  preview(body) {
    body = unwrapSessionGraph(body);
    const log = graphDisclosureLogSchema.safeParse(body);
    if (log.success) return { kind: "rows", total: log.data.items.length, rows: log.data.items.slice(-100).map(item => ({
      label: `${item.operation} · ${item.delivery} · ${item.referenceId}`,
      text: `固定上限 ${item.cutoffEventId}；${item.ranges.map(range => `${range.eventId} [${range.start},${range.end})`).join("；")}；${item.hasMore ? "仍有未读范围" : "本次页已结束"}`.slice(0, 2000),
    })) };
    const value=canvas.parse(body),nodes=value.nodes.slice(0,100),ids=new Set(nodes.map(n=>n.id));
    return {kind:"graph",total:value.nodes.length,nodes:nodes.map(n=>({id:n.id,label:typeof n.data.label==="string"?n.data.label.slice(0,60):typeof n.data.question==="string"?n.data.question.slice(0,60):n.id,x:n.position.x,y:n.position.y})),
      edges:value.edges.filter(e=>ids.has(e.source)&&ids.has(e.target)).slice(0,300).map(e=>({source:e.source,target:e.target}))};
  },
};
export const annotationAdapter: ExtensionDataAdapter = {
  capabilities,
  panelAdapter: obsidianPanel,
  ownership() { return { ownerSessionId: null, kind: "legacy-reference-set", readOnly: true, reason: "旧引用集合使用原生会话身份，需要核验或同步逻辑会话归属" }; },
  namespace: "annotation", label: "注释与贴纸", pluginVersions: ["0.3.6"], schemaVersions: [1],
  validate(content) { const result = referenceSet.parse(content.body); unique(result.items.map(i=>i.referenceId)); },
  summarize(body) { return `${referenceSet.parse(body).items.length} 条引用`; },
  preview(body) { const value=referenceSet.parse(body);return {kind:"rows",total:value.items.length,rows:value.items.slice(0,100).map(i=>({label:i.selectedText.slice(0,500),text:i.userComment.slice(0,2000)}))}; },
};
// Link-only v1. Vault remains the sole owner of note text. No snapshot body field.
const knowledgeLink = z.strictObject({ vaultId: id, notePath: id, blockId: id.optional(),
  links: z.array(z.strictObject({ target: id, relation: z.enum(["reference","backlink"]) })).max(1000),
  syncState: z.enum(["pending","synced","failed"]), sourceVersion: id.optional() });
export const obsidianLinksAdapter: ExtensionDataAdapter = {
  capabilities,
  panelAdapter: obsidianPanel,
  ownership(content) {
    const link = knowledgeLinkSchema.safeParse(content.body);
    return link.success ? { ownerSessionId: link.data.logicalSessionId, kind: "note-link" }
      : { ownerSessionId: null, kind: "legacy-note-links", readOnly: true, reason: "旧链接可能包含多个目标，需明确所属会话" };
  },
  namespace: "obsidian-links", label: "知识链接", pluginVersions: ["0.3.23", "0.6.4-rc2.4", "0.6.4-rc2.5", "0.6.4-rc2.6", "0.6.4-rc2.7", "0.7.0-rc2.1", "0.7.0-rc2.3", "0.7.0-rc2.4", "0.7.0-rc2.5"], schemaVersions: [1, 2],
  validate(content) { (content.schemaVersion === 2 ? knowledgeLinkSchema : knowledgeLink).parse(content.body); },
  summarize(body) { const managed=knowledgeLinkSchema.safeParse(body);if(managed.success)return `${managed.data.note.notePath} · ${managed.data.syncState}`;const link = knowledgeLink.parse(body); return `${link.notePath} · ${link.links.length} 条链接`; },
  preview(body) { const managed=knowledgeLinkSchema.safeParse(body);if(managed.success)return {kind:'rows',total:1,rows:[{label:managed.data.note.notePath,text:managed.data.logicalSessionId}]};const link=knowledgeLink.parse(body);return {kind:"rows",total:link.links.length,rows:link.links.slice(0,100).map(l=>({label:l.target,text:l.relation==="backlink"?"双链":"引用"}))}; },
};
export const stickerAdapter: ExtensionDataAdapter = {
  panelAdapter: obsidianPanel,
  ownership(content) {
    const value = stickerObjectSchema.parse(content.body);
    return { ownerSessionId: value.logicalSessionId, kind: value.kind === "migration" ? "migration-receipt" : value.kind === "session" ? "session-sticker" : "annotation-sticker",
      readOnly: value.kind === "migration" };
  },
  capabilities, namespace: 'stickers', label: '会话贴纸', pluginVersions: ['0.7.3-rc2.9', '0.7.3-rc2.10', '0.7.3-rc2.11', '0.7.3-rc2.12', '0.7.3-rc2.13', '0.7.3-rc2.14', '0.7.3-rc2.15', '0.7.3-rc2.16', '0.7.3-rc2.17', '0.7.3-rc2.18', '0.7.3-rc2.19', '0.7.4-rc2.1', '0.7.4-rc2.2', '0.7.4-rc2.3', '0.7.4-rc2.5', '0.7.4-rc2.6'], schemaVersions: [1],
  validate(content) { stickerObjectSchema.parse(content.body); },
  summarize(body) { const value=stickerObjectSchema.parse(body);return value.kind==='session'?'独立会话入口':value.kind==='migration'?`迁移 · ${value.phase}`:'普通贴纸'; },
  preview(body) { const value=stickerObjectSchema.parse(body);return {kind:'rows',total:1,rows:[{label:value.kind==='session'?'目标会话':value.kind==='migration'?'迁移目标':'所属会话',text:value.logicalSessionId}]}; },
};
export const upstreamAdapter: ExtensionDataAdapter = {
  panelAdapter: obsidianPanel,
  ownership(content) { const record = sessionContextRecordSchema.parse(content.body); return { ownerSessionId: record.targetSessionId, kind: "upstream-reference", readOnly: true }; },
  capabilities,namespace:SESSION_CONTEXT_NAMESPACE,label:"跨会话上游引用",pluginVersions:["0.3.12-rc2.1","0.3.12-rc2.2","0.3.12-rc2.3","0.3.12-rc2.4","0.3.12-rc2.5","0.3.12-rc2.6","0.3.12-rc2.7","0.3.12-rc2.8","0.3.12-rc2.9","0.3.12-rc2.10","0.3.12-rc2.11","0.3.12-rc2.12","0.3.12-rc2.19", "0.3.12-rc2.20", "0.3.12-rc2.21"],schemaVersions:[1],
  validate(content){sessionContextRecordSchema.parse(content.body);},
  summarize(body){const r=sessionContextRecordSchema.parse(body);return `${r.sourceTitle} · ${{pending:'待发送',sent:'已发送',revoked:'已解除'}[r.state]}`;},
  preview(body){const r=sessionContextRecordSchema.parse(body);return {kind:"rows",total:1,rows:[{label:r.sourceTitle,text:r.selectedText.slice(0,2000)}]};},
};
export const annotationRecordsAdapter: ExtensionDataAdapter = {
  namespace: ANNOTATION_RECORDS_NAMESPACE, label: "引用条目", panelAdapter: obsidianPanel,
  pluginVersions: ["0.3.12-rc2.9", "0.3.12-rc2.10","0.3.12-rc2.11","0.3.12-rc2.12","0.3.12-rc2.19", "0.3.12-rc2.20", "0.3.12-rc2.21"], schemaVersions: [1],
  capabilities: { ...capabilities, write: false, delete: false, restore: false },
  validate(content) { annotationMirrorRecordSchema.parse(content.body); },
  ownership(content) { const record = annotationMirrorRecordSchema.parse(content.body); return { ownerSessionId: record.targetSessionId,
    kind: record.sourceType === "obsidian-note" ? "obsidian-reference" : "message-reference", readOnly: true,
    ...(record.source.upstreamReferenceId ? { canonicalReferenceId: record.source.upstreamReferenceId } : {}) }; },
  summarize(body) { const record = annotationMirrorRecordSchema.parse(body); return `${record.sourceType === "obsidian-note" ? "笔记引用" : "会话引用"} · ${mirrorState[record.state]}`; },
  preview(body) {
    const record = annotationMirrorRecordSchema.parse(body);
    const rows = [{ label: "选中文本", text: record.selectedText }, { label: "评论", text: record.userComment },
      { label: "来源", text: `${record.sourceType === "obsidian-note" ? "Obsidian 笔记" : "DSH 会话"} · ${record.source.title || record.source.notePath || "来源信息未提供"}` },
      { label: "状态", text: mirrorState[record.state] }];
    if (record.truncated) rows.push({ label: "摘录范围", text: "此处仅保存有界摘录，原文较长的部分已截断。" });
    return { kind: "rows", total: rows.length, rows };
  },
};
export const nativeContextAdapter: ExtensionDataAdapter = {
  namespace: NATIVE_CONTEXT_NAMESPACE, label: "上下文管理", panelAdapter: obsidianPanel,
  pluginVersions: ["0.3.12-rc2.11","0.3.12-rc2.12","0.3.12-rc2.19", "0.3.12-rc2.20", "0.3.12-rc2.21"], schemaVersions: [1],
  capabilities: { ...capabilities, write: false, delete: false, restore: false },
  validate(content) { const state=nativeContextStateSchema.parse(content.body);unique(state.sources.map(s=>s.referenceId));
    unique(state.materials.map(m=>m.materialId));unique(state.operations.map(op=>op.operationId)); },
  ownership(content) { const state=nativeContextStateSchema.parse(content.body);return {ownerSessionId:state.ownerSessionId,kind:"native-context",readOnly:true}; },
  summarize(body) { const state=nativeContextStateSchema.parse(body);return `${state.sources.length} 个来源 · ${state.materials.filter(m=>m.state==='retained').length} 项保留材料 · ${state.operations.filter(op=>op.state==='pending-next-step').length} 项待生效`; },
  preview(body) { const state=nativeContextStateSchema.parse(body);return {kind:"rows",total:state.sources.length,rows:state.sources.slice(0,100).map(source=>({
    label:source.title,text:`${source.enabled?'启用':'暂停'} · 固定上限 ${source.cutoffEventId} · ${source.window===null?'授权范围内按需读取':`${source.window.length} 个披露区间`}`
  }))}; },
};
export const builtInExtensionAdapters = [thoughtDagAdapter, annotationAdapter, obsidianLinksAdapter, upstreamAdapter, stickerAdapter, annotationRecordsAdapter, nativeContextAdapter, gptCompatExtensionAdapter] as const;
