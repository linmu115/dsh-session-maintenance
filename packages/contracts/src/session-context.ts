import { z } from "zod";
import type { CanonicalEventV1 } from "./canonical.js";
import type { JsonValue } from "./model.js";

const id = z.string().min(1).max(256);
export const SESSION_CONTEXT_NAMESPACE = "annotation-upstream";
export const sessionContextScopeSchema = z.strictObject({ runId: id, targetNativeSessionId: id });
export const sessionContextCaptureSchema = sessionContextScopeSchema.extend({
  operationId: id, sourceNativeSessionId: id, anchorId: id,
  selectedText: z.string().min(1).max(16000),
  expectedSourceVersionId: id.optional(),
});
export const sessionContextRecordSchema = z.strictObject({
  schemaVersion: z.literal(1), referenceId: id, sourceSessionId: id, sourceVersionId: id,
  cutoffEventId: id, cutoffDigest: id, targetSessionId: id, selectedText: z.string().max(16000),
  sourceTitle: z.string().max(500), sourceAnchorId: id, state: z.enum(["pending", "sent", "revoked"]),
  targetMessageId: id.nullable(), createdAt: z.string(),
});
export const sessionContextReadSchema = sessionContextScopeSchema.extend({
  referenceId: id, executionId: id, cursor: z.string().max(2048).optional(),
  query: z.string().min(1).max(200).optional(),
  view: z.literal("selected-turn").optional(),
  maxBytes: z.number().int().min(1024).max(16000).default(8000),
  totalBytes: z.number().int().min(1024).max(64000).default(24000),
});
export type SessionContextCapture = z.infer<typeof sessionContextCaptureSchema>;
export type SessionContextRecord = z.infer<typeof sessionContextRecordSchema>;
export type SessionContextRead = z.input<typeof sessionContextReadSchema>;
export interface SessionContextCutoff { eventId: string; digest: string }
export interface SessionContextEntry { eventId: string; role: string; text: string }
/** Format knowledge stays in the version Adapter. No on-disk materialization. */
export interface SessionContextAdapter {
  cutoff(events: readonly CanonicalEventV1[], projection: JsonValue, anchorId: string): SessionContextCutoff;
  entries(events: readonly CanonicalEventV1[]): readonly SessionContextEntry[];
  /** First model-visible event of the turn ending at the supplied completed-reply cutoff. */
  selectedTurnStart(events: readonly CanonicalEventV1[]): string;
  selectedReply(events: readonly CanonicalEventV1[]): string;
}
export interface SessionContextPage {
  referenceId: string; sourceSessionId: string; sourceVersionId: string; cutoffEventId: string;
  items: Array<{ eventId: string; role: string; text: string; offset: number; complete: boolean; readCursor?: string }>;
  nextCursor: string | null; hasMore: boolean; remainingBytes: number; budgetExhausted: boolean;
  /** Present for the initial chronological turn and its continuations. Older history stays on demand. */
  selectedTurn?: { complete: boolean; omittedIntermediateItems?: number; detailsCursor?: string };
}
export interface SessionContextDirectory {
  items: Array<{ id: string; title: string; logicalSessionId?: string }>;
  nextCursor: string | null;
}
