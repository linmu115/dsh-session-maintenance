import { z } from "zod";
import type { GraphDocument, GraphDisclosureCoverage } from "./session-graph.js";

export const NATIVE_CONTEXT_NAMESPACE = "annotation-context";
export const NATIVE_CONTEXT_PROTOCOL_VERSION = 1 as const;
const id = z.string().min(1).max(256);
const number = z.number().int().nonnegative();
export const nativeContextRangeSchema = z.strictObject({ startEventId: id, endEventId: id });
export type NativeContextRange = z.infer<typeof nativeContextRangeSchema>;
export const nativeContextMaterialRangeSchema = z.strictObject({ referenceId: id, eventId: id, start: number, end: number })
  .refine(value => value.end >= value.start, "Material range is reversed");
export const nativeContextMaterialInputSchema = z.strictObject({
  materialId: id, eventSeq: number, referenceIds: z.array(id).max(64),
  kind: z.enum(["initial", "read", "search", "requests"]), bytes: number.max(4 * 1024 * 1024),
  contentHash: z.string().min(1).max(128), ranges: z.array(nativeContextMaterialRangeSchema).max(256),
  sourceEventSeqs: z.array(number).max(256).optional(),
});
export type NativeContextMaterialInput = z.infer<typeof nativeContextMaterialInputSchema>;
export const nativeContextMaterialSchema = nativeContextMaterialInputSchema.extend({
  state: z.enum(["retained", "release-pending", "released", "unavailable"]),
  pinnedByUser: z.boolean(), pinnedByModel: z.boolean(), createdAt: z.string(),
  releasedReferenceIds: z.array(id).max(64).default([]),
});
export type NativeContextMaterial = z.infer<typeof nativeContextMaterialSchema>;
export const nativeContextOperationSchema = z.strictObject({
  operationId: id, digest: id, action: id, actor: z.enum(["user", "model", "host"]), executionId: id,
  state: z.enum(["applied", "pending-next-step", "failed", "unsupported"]),
  materialIds: z.array(id).max(256), reason: z.string().max(500), createdAt: z.string(),
  appliedAt: z.string().optional(), surfaceEventSeqs: z.array(number).max(256).optional(),
  sourceEventSeqs: z.array(number).max(256).optional(), releasedBytes: number.optional(),
});
export type NativeContextOperation = z.infer<typeof nativeContextOperationSchema>;
export const nativeContextSourceSchema = z.strictObject({
  referenceId: id, sourceSessionId: id, sourceVersionId: id, cutoffEventId: id, title: z.string().max(500),
  enabled: z.boolean(), window: z.array(nativeContextRangeSchema).max(64).nullable(),
  generation: number.default(0), activation: z.strictObject({ executionId: id, operationId: id }).optional(),
  authorityState: z.enum(["pending", "sent", "revoked", "unavailable"]),
});
export type NativeContextSource = z.infer<typeof nativeContextSourceSchema>;
export const nativeContextStateSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("native-context"), ownerSessionId: id,
  sources: z.array(nativeContextSourceSchema).max(256), materials: z.array(nativeContextMaterialSchema).max(256),
  operations: z.array(nativeContextOperationSchema).max(128), trimmedMaterials: number, trimmedOperations: number,
  retiredThroughSeq: z.number().int().min(-1).default(-1),
});
export type NativeContextState = z.infer<typeof nativeContextStateSchema>;
export interface NativeContextDocument extends NativeContextState {
  protocolVersion: 1; objectId: string; revision: number; nativeSessionId: string;
  graph?: GraphDocument;
  coverage?: GraphDisclosureCoverage[];
  coverageTruncated?: boolean;
  coverageRevision?: string;
}
export const nativeContextScopeSchema = z.strictObject({
  runId: id, targetNativeSessionId: id, actor: z.enum(["user", "model", "host"]), executionId: id,
});
export type NativeContextScope = z.infer<typeof nativeContextScopeSchema>;
const mutation = nativeContextScopeSchema.extend({ operationId: id, expectedRevision: number, reason: z.string().max(500).default("") });
export const nativeContextWindowSchema = mutation.extend({ referenceId: id, ranges: z.array(nativeContextRangeSchema).max(64).nullable() });
export const nativeContextSourceSetSchema = mutation.extend({ referenceId: id, enabled: z.boolean(), release: z.boolean().default(false) });
export const nativeContextReleaseSchema = mutation.extend({ referenceId: id.optional(), materialIds: z.array(id).min(1).max(256).optional() })
  .refine(value => Boolean(value.referenceId) !== Boolean(value.materialIds), "Select referenceId or materialIds");
export const nativeContextPinSchema = mutation.extend({ materialIds: z.array(id).min(1).max(256), pinned: z.boolean() });
export const nativeContextRegisterSchema = nativeContextScopeSchema.extend({ materials: z.array(nativeContextMaterialInputSchema).max(50) });
export const nativeContextReceiptSchema = nativeContextScopeSchema.extend({
  operationId: id, state: z.enum(["applied", "failed"]), surfaceEventSeqs: z.array(number).max(256),
  sourceEventSeqs: z.array(number).max(256), releasedBytes: number, reason: z.string().max(500).optional(),
});
export const nativeContextGraphEditSchema = mutation.extend({
  action: z.enum(["add-placeholder", "add-session", "rename", "connect", "disconnect", "remove-node"]),
  nodeId: id.optional(), label: z.string().max(500).optional(), sourceNativeSessionId: id.optional(),
  referenceId: id.optional(), sourceAnchorId: id.optional(), sourceVersionId: id.optional(), graphRevision: number.optional(),
});
export interface NativeContextReleasePlans { items: NativeContextOperation[]; materials: NativeContextMaterial[]; revision: number }
