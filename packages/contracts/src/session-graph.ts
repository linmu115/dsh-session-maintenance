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
  kind: z.enum(["session", "sticker", "material", "note"]), label: z.string().max(500),
  logicalSessionId: id.optional(), namespace: id.optional(), objectId: id.optional(), referenceId: id.optional(),
  excerpt: z.string().max(4000).optional(), sourceVersionId: id.optional(), sourceAnchorId: id.optional(),
}).superRefine((value, ctx) => {
  if (value.kind === "session" && !value.logicalSessionId)
    ctx.addIssue({ code: "custom", message: "会话节点必须引用逻辑会话身份" });
  if ((value.kind === "sticker" || value.kind === "note") && (!value.namespace || !value.objectId))
    ctx.addIssue({ code: "custom", message: "扩展节点必须引用权威数据域及对象身份" });
  if (value.kind === "material" && (!value.logicalSessionId || !value.sourceVersionId || !value.sourceAnchorId))
    ctx.addIssue({ code: "custom", message: "材料节点必须引用逻辑会话、来源版本及回复身份" });
  if (Boolean(value.namespace) !== Boolean(value.objectId))
    ctx.addIssue({ code: "custom", message: "扩展数据域及对象身份必须同时提供" });
});
const edgeData = z.strictObject({
  kind: z.enum(["branch", "upstream", "knowledge"]), relationId: id.optional(), namespace: id.optional(),
}).superRefine((value, ctx) => {
  if (value.kind !== "knowledge" && (!value.relationId || value.namespace !== "annotation-upstream"))
    ctx.addIssue({ code: "custom", message: "上下文与分支呈现必须引用 Annotation 的权威关系" });
  if (Boolean(value.relationId) !== Boolean(value.namespace))
    ctx.addIssue({ code: "custom", message: "关系身份与数据域必须同时提供" });
});
/** Presentation only: no embedded transcript, prompt or execution permission. */
export const managedGraphSchema = z.strictObject({
  managedSchema: z.literal(1),
  nodes: z.array(z.strictObject({ id, position: point, data: nodeData })).max(10000),
  edges: z.array(z.strictObject({ id, source: id, target: id, data: edgeData })).max(20000),
  viewport: point.extend({ zoom: z.number().finite().positive().max(100) }).optional(),
});
export type ManagedGraph = z.infer<typeof managedGraphSchema>;
