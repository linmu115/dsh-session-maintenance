import { z } from "zod";
import { ExtensionDataError, type ExtensionDataAdapter } from "@linmu/dsh-session-contracts";

const id = z.string().min(1);
const capabilities = { read:true,write:true,delete:true,restore:true,panel:true,context:false } as const;
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
    backlinkState: z.enum(["not-required","pending","written","failed"]), sourceType: z.enum(["dsh-message","obsidian-note"]),
    locator: z.record(z.string(),z.unknown()) }).passthrough()).max(1000),
}).passthrough();
function unique(ids: string[]): void {
  if (new Set(ids).size !== ids.length) throw new ExtensionDataError("EXTENSION_INVALID_OBJECT", "对象中存在重复身份。",422);
}
export const thoughtDagAdapter: ExtensionDataAdapter = {
  capabilities,
  namespace: "thoughtdag", label: "ThoughtDAG", pluginVersions: ["0.4.11"], schemaVersions: [1],
  validate(content) {
    const result = canvas.parse(content.body); unique(result.nodes.map(n=>n.id)); unique(result.edges.map(e=>e.id));
    const ids = new Set(result.nodes.map(n=>n.id));
    if (result.edges.some(e=>!ids.has(e.source)||!ids.has(e.target))) throw new ExtensionDataError("EXTENSION_INVALID_OBJECT", "画布连线引用了不存在的节点。",422);
  },
  summarize(body) { const value = canvas.parse(body); return `${value.nodes.length} 个节点 · ${value.edges.length} 条连线`; },
  preview(body) {
    const value=canvas.parse(body),nodes=value.nodes.slice(0,100),ids=new Set(nodes.map(n=>n.id));
    return {kind:"graph",total:value.nodes.length,nodes:nodes.map(n=>({id:n.id,label:typeof n.data.question==="string"?n.data.question.slice(0,60):n.id,x:n.position.x,y:n.position.y})),
      edges:value.edges.filter(e=>ids.has(e.source)&&ids.has(e.target)).slice(0,300).map(e=>({source:e.source,target:e.target}))};
  },
};
export const annotationAdapter: ExtensionDataAdapter = {
  capabilities,
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
  namespace: "obsidian-links", label: "知识链接", pluginVersions: ["0.3.23"], schemaVersions: [1],
  validate(content) { knowledgeLink.parse(content.body); },
  summarize(body) { const link = knowledgeLink.parse(body); return `${link.notePath} · ${link.links.length} 条链接`; },
  preview(body) { const link=knowledgeLink.parse(body);return {kind:"rows",total:link.links.length,rows:link.links.slice(0,100).map(l=>({label:l.target,text:l.relation==="backlink"?"双链":"引用"}))}; },
};
export const builtInExtensionAdapters = [thoughtDagAdapter, annotationAdapter, obsidianLinksAdapter] as const;
