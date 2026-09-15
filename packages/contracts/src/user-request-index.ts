import { z } from "zod";

const id = z.string().min(1).max(512);
/** All identity and authorization is resolved server-side from this execution. */
export const userRequestListSchema = z.strictObject({
  runId: id, targetNativeSessionId: id, executionId: id,
  referenceId: id.optional(), requestId: id.optional(),
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.number().int().min(1).max(25).default(10),
  maxBytes: z.number().int().min(2048).max(16000).default(8000),
  totalBytes: z.number().int().min(2048).max(64000).default(24000),
});
export const userRequestLocateSchema = userRequestListSchema.pick({
  runId: true, targetNativeSessionId: true, executionId: true, referenceId: true,
}).extend({ requestId: id, snapshot: id.optional() });
export const userRequestSessionListSchema = userRequestListSchema.pick({
  requestId: true, cursor: true, limit: true, maxBytes: true,
}).extend({ logicalSessionId: id });
export type UserRequestList = z.input<typeof userRequestListSchema>;
export type UserRequestLocate = z.input<typeof userRequestLocateSchema>;
export type UserRequestSessionList = z.input<typeof userRequestSessionListSchema>;
export type UserRequestState = "pending" | "running" | "completed" | "failed" | "cancelled" | "unknown";
export type UserRequestRelation = "initial" | "supplement" | "unknown";
export type UserRequestAssociationState = "verified" | "partial" | "unknown";
export interface UserRequestAttachmentRef {
  id: string; type: string; name: string | null; mimeType: string | null;
}
export interface UserRequestExecutionRef {
  id: string; boundaryEventId: string | null; endEventId: string | null; state: UserRequestState;
}
export interface UserRequestReplyRef {
  eventId: string; nativeMessageId: string | null; completed: boolean;
}
/** Stable, version-bound navigation. This does not say any answer body was read. */
export interface UserRequestLocation {
  requestEventId: string; startEventId: string; endEventId: string;
  replyEventId: string | null; readCursor: string; rangeState: "complete" | "partial" | "request-only";
}
export interface UserRequestEntry {
  requestId: string; eventId: string; nativeMessageId: string | null;
  ordinal: number; createdAt: string | null;
  text: string; totalChars: number; textOffset: number; nextTextCursor: string | null;
  sourceTrust: "verified" | "unverified";
  attachmentRefs: UserRequestAttachmentRef[]; attachmentsOmitted: number;
  executionRefs: UserRequestExecutionRef[]; replyRefs: UserRequestReplyRef[]; replyRefsOmitted: number;
  turnId: string | null; turnBoundaryEventId: string | null;
  relation: UserRequestRelation; state: UserRequestState; associationState: UserRequestAssociationState;
  location: UserRequestLocation | null;
}
export interface UserRequestPage {
  schemaVersion: 1; snapshot: string; logicalSessionId: string; sourceVersionId: string;
  referenceId: string | null; cutoffEventId: string | null;
  /** A directory response never mounts the associated replies or tool results. */
  directoryOnly: true; items: UserRequestEntry[]; nextCursor: string | null; hasMore: boolean;
  remainingBytes: number; budgetExhausted: boolean;
}
export interface UserRequestLocated {
  schemaVersion: 1; snapshot: string; logicalSessionId: string; sourceVersionId: string;
  referenceId: string | null; cutoffEventId: string | null; requestId: string;
  location: UserRequestLocation;
}
