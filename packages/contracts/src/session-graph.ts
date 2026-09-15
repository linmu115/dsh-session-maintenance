import { z } from "zod";
import type { CanonicalEventV1 } from "./canonical.js";
import type { JsonValue } from "./model.js";
import type { SessionContextEntry, SessionContextRecord } from "./session-context.js";

const id = z.string().min(1).max(256);
export const graphResolveSchema = z.union([
  z.strictObject({ logicalSessionId: id }),
  z.strictObject({ nativeSessionId: id }),
]);
export type GraphResolve = z.infer<typeof graphResolveSchema>;
export interface GraphSessionIdentity { logicalSessionId: string; nativeSessionId: string; title: string }
export interface GraphPreviewSelection { sourceVersionId: string; sourceAnchorId: string }
export interface GraphCapture {
  sourceSessionId: string; anchorId: string; messageId: string;
  role: "assistant"; occurrence: 0; selectedText: string;
}
export interface GraphPreviewPage extends GraphSessionIdentity {
  sourceVersionId: string;
  items: Array<SessionContextEntry & { offset: number; complete: boolean }>;
  capture: GraphCapture;
  nextCursor: string | null; hasMore: boolean;
}
export interface GraphRelation extends Pick<SessionContextRecord,
  "referenceId" | "sourceSessionId" | "targetSessionId" | "sourceVersionId" | "cutoffEventId" |
  "sourceAnchorId" | "state" | "targetMessageId"> {
  namespace: "annotation-upstream"; objectId: string; revision: number;
}
export interface GraphRelationPage { items: GraphRelation[]; nextCursor: string | null }
export interface GraphCompletedTurn {
  cutoffEventId: string; anchorId: string; messageId: string;
  entries: readonly SessionContextEntry[]; selectedText: string;
}
/** Only version Adapters interpret native completion and anchor formats. */
export interface SessionGraphAdapter {
  completedTurn(events: readonly CanonicalEventV1[], projection: JsonValue, beforeEventId?: string, anchorId?: string): GraphCompletedTurn | undefined;
}

const point = z.strictObject({ x: z.number().finite(), y: z.number().finite() });
const nodeData = z.strictObject({
  kind: z.enum(["session", "sticker", "material", "note", "placeholder"]), label: z.string().max(500),
  logicalSessionId: id.optional(), namespace: id.optional(), objectId: id.optional(), referenceId: id.optional(),
  excerpt: z.string().max(4000).optional(), sourceVersionId: id.optional(), sourceAnchorId: id.optional(),
  creationWorkspaceId: id.optional(),
}).superRefine((value, ctx) => {
  if (value.creationWorkspaceId && value.kind !== "placeholder")
    ctx.addIssue({ code: "custom", message: "工作区创建意图仅适用于未绑定空卡片" });
  if (value.kind === "session" && !value.logicalSessionId)
    ctx.addIssue({ code: "custom", message: "会话节点必须引用逻辑会话身份" });
  if ((value.kind === "sticker" || value.kind === "note") && (!value.namespace || !value.objectId))
    ctx.addIssue({ code: "custom", message: "扩展节点必须引用权威数据域及对象身份" });
  if (value.kind === "material" && (!value.logicalSessionId || !value.sourceVersionId || !value.sourceAnchorId))
    ctx.addIssue({ code: "custom", message: "材料节点必须引用逻辑会话、来源版本及回复身份" });
  if (Boolean(value.namespace) !== Boolean(value.objectId))
    ctx.addIssue({ code: "custom", message: "扩展数据域及对象身份必须同时提供" });
});
const legacyEdgeData = z.strictObject({
  kind: z.enum(["branch", "upstream", "knowledge"]), relationId: id.optional(), namespace: id.optional(),
}).superRefine((value, ctx) => {
  if (value.kind !== "knowledge" && (!value.relationId || value.namespace !== "annotation-upstream"))
    ctx.addIssue({ code: "custom", message: "上下文与分支呈现必须引用 Annotation 的权威关系" });
  if (Boolean(value.relationId) !== Boolean(value.namespace))
    ctx.addIssue({ code: "custom", message: "关系身份与数据域必须同时提供" });
});
/** Presentation only: no embedded transcript, prompt or execution permission. */
export const legacyManagedGraphSchema = z.strictObject({
  managedSchema: z.literal(1),
  nodes: z.array(z.strictObject({ id, position: point, data: nodeData })).max(10000),
  edges: z.array(z.strictObject({ id, source: id, target: id, data: legacyEdgeData })).max(20000),
  viewport: point.extend({ zoom: z.number().finite().positive().max(100) }).optional(),
});
const graphEdge = z.strictObject({ id, source: id, target: id, data: z.strictObject({
  kind: z.enum(["branch", "upstream", "pending"]), relationId: id.optional(), namespace: id.optional(),
  sourceVersionId: id.optional(), cutoffEventId: id.optional(), sourceAnchorId: id.optional(),
  state: z.enum(["pending", "sent", "revoked"]).optional(), targetMessageId: id.nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.kind === "pending" ? Boolean(value.relationId || value.namespace) : !value.relationId || value.namespace !== "annotation-upstream")
    ctx.addIssue({ code: "custom", message: "活动连接必须引用权威关系；待绑定连接不能声明读取权限" });
  if (value.kind === "pending" && (value.sourceVersionId || value.cutoffEventId || value.sourceAnchorId || value.state || value.targetMessageId))
    ctx.addIssue({ code: "custom", message: "待绑定连接不能声明固定上限或已发送状态" });
}) });
export const managedGraphSchema = z.strictObject({
  managedSchema: z.literal(2), ownerSessionId: id.nullable(),
  archivedAt: z.string().datetime().nullable().optional(),
  nodes: z.array(z.strictObject({ id, position: point, data: nodeData })).max(10000),
  edges: z.array(graphEdge).max(20000),
  viewport: point.extend({ zoom: z.number().finite().positive().max(100) }).optional(),
  removedRelationIds: z.array(id).max(20000).optional(),
  migration: z.strictObject({ sourceObjectId: id, status: z.enum(["verified", "needs-review"]), reason: z.string().max(500).optional() }).optional(),
  legacyEdges: z.array(z.strictObject({ id, source: id, target: id, data: legacyEdgeData })).max(20000).optional(),
}).superRefine((value, ctx) => {
  const nodes = new Set(value.nodes.map(n => n.id)), edges = new Set(value.edges.map(e => e.id));
  if (nodes.size !== value.nodes.length || edges.size !== value.edges.length)
    ctx.addIssue({ code: "custom", message: "图对象身份不能重复" });
  if (value.edges.some(e => !nodes.has(e.source) || !nodes.has(e.target)))
    ctx.addIssue({ code: "custom", message: "连接端点不存在" });
});
export type ManagedGraph = z.infer<typeof managedGraphSchema>;
export interface GraphDocument { objectId: string; revision: number; title: string; graph: ManagedGraph; reused?: boolean; draftObjectId?: string | undefined }
export interface GraphSave { objectId?: string | undefined; expectedRevision: number; title?: string | undefined; graph: ManagedGraph }
export interface GraphRemove { objectId: string; expectedRevision: number; nodeIds?: string[] | undefined; edgeIds?: string[] | undefined; operationId: string }
export interface GraphBind { objectId: string; expectedRevision: number; logicalSessionId: string }
export const graphDisclosureRangeSchema = z.strictObject({ eventId: id, messageId: id.optional(), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), complete: z.boolean().optional() })
  .refine(value => value.end >= value.start, "返回区间结束不能早于开始");
export const graphDisclosureInputSchema = z.strictObject({
  requestId: id, executionId: id, operation: z.enum(["initial", "read", "search", "preview"]),
  delivery: z.enum(["prepared", "returned", "failed"]),
  ranges: z.array(graphDisclosureRangeSchema).max(256),
  nextCursor: z.string().max(4096).nullable(), hasMore: z.boolean(), truncated: z.boolean(),
  next: z.strictObject({ eventId: id, offset: z.number().int().nonnegative() }).nullable().optional(),
  selectedTurnComplete: z.boolean().optional(), remainingBytes: z.number().int().nonnegative().optional(),
  returnedBytes: z.number().int().nonnegative().max(1000000),
  status: z.enum(["ok", "empty", "budget-exhausted", "unavailable", "revoked"]),
});
export type GraphDisclosureInput = z.infer<typeof graphDisclosureInputSchema>;
export const graphDisclosureReceiptSchema = graphDisclosureInputSchema.extend({
  receiptId: id, referenceId: id, sourceSessionId: id, targetSessionId: id, sourceVersionId: id, cutoffEventId: id,
  recordedAt: z.string().datetime(),
});
export type GraphDisclosureReceipt = z.infer<typeof graphDisclosureReceiptSchema>;
export const graphDisclosureLogSchema = z.strictObject({
  kind: z.literal("disclosure-log"), managedSchema: z.literal(2), ownerSessionId: id, graphObjectId: id,
  trimmed: z.boolean(), trimmedCount: z.number().int().nonnegative(),
  items: z.array(graphDisclosureReceiptSchema).max(256),
});
export interface GraphDisclosureCoverage { referenceId: string; sourceVersionId: string; executionId: string; eventId: string; ranges: Array<{ start: number; end: number }> }
export interface GraphDisclosurePage { items: GraphDisclosureReceipt[]; nextCursor: string | null; trimmed: boolean; trimmedCount: number; maxEntries: number; maxBytes: number;
  /** Coverage describes this returned page only and excludes prepared or failed deliveries. */
  coverage: GraphDisclosureCoverage[]; coverageTruncated: boolean }
export interface GraphSourceMarker { objectId: string; referenceId: string; sourceVersionId: string; sourceAnchorId: string; messageId: string; selectedText: string; occurrence: number; targetLogicalSessionId: string; targetTitle: string }
export interface GraphSourceMarkerPage { items: GraphSourceMarker[]; nextCursor: string | null }
