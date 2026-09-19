import { z } from "zod";
import type { CodexContinuationTarget } from "./continuations.js";

const id = z.string().min(1).max(256);
export const LEARNING_SKIPPED_IMAGE_TEXT = "[图片已跳过]";
export const learningMessageSchema = z.object({ id, role: z.enum(["user", "assistant"]), text: z.string().min(1),
  startedAt: z.string().nullable(), completedAt: z.string().nullable(), skippedImages: z.number().int().nonnegative().optional() });
export type LearningMessage = z.infer<typeof learningMessageSchema>;
export interface LearningCursor { readonly count: number; readonly digest: string }
export interface LearningSnapshot {
  readonly cursor: LearningCursor;
  readonly messages: readonly LearningMessage[];
  readonly busy: boolean;
  readonly name: string;
}
/** Adapter owns native parsing and injection. Cursor checks include non-message history changes. */
export interface LearningCodexPort {
  read(target: CodexContinuationTarget, threadId: string, after?: LearningCursor): Promise<LearningSnapshot>;
  inject(target: CodexContinuationTarget, threadId: string, before: LearningCursor, operationId: string,
    messages: readonly LearningMessage[]): Promise<LearningSnapshot>;
}
export const learningBindSchema = z.strictObject({ logicalSessionId: id, targetPresetId: id, codexThreadId: id,
  dshRunId: id, confirmed: z.literal(true) });
export type LearningBind = z.infer<typeof learningBindSchema>;
export const learningBindingSchema = z.object({ id, logicalSessionId: id, title: z.string(), targetPresetId: id,
  codexThreadId: id, dshInstanceId: id, dshProfileId: id, dshNativeSessionId: id,
  state: z.enum(["ready", "sending", "sent", "collected", "conflict", "uncertain", "disabled"]),
  message: z.string(), imageNotice: z.string().optional(), sentAt: z.string().nullable(), collectedAt: z.string().nullable(), revision: z.number().int(),
  blockedReason: z.string().nullable() });
export type LearningBinding = z.infer<typeof learningBindingSchema>;
export const learningDirectorySchema = z.object({ bindings: z.array(learningBindingSchema),
  targets: z.array(z.object({ id, label: z.string(), codexInstanceId: id.optional() })),
  candidates: z.array(z.object({ logicalSessionId: id, title: z.string(), codexThreadId: id, codexInstanceId: id,
    dshRunId: id, dshLabel: z.string(), blockedReason: z.string().nullable().optional() })) });
export type LearningDirectory = z.infer<typeof learningDirectorySchema>;
