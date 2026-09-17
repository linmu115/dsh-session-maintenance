import { z } from "zod";

/** Derived metadata only. Opaque payloads remain in the authoritative session version. */
export const gptExtensionSummarySchema = z.strictObject({
  kind: z.literal("gpt-session-state"), ownerSessionId: z.string().min(1),
  sourceVersion: z.string().min(1), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  eventCount: z.number().int().nonnegative(), checkpoints: z.number().int().nonnegative(),
  commits: z.number().int().nonnegative(), nativeCompactions: z.number().int().nonnegative(),
  portableSummaries: z.number().int().nonnegative(), results: z.number().int().nonnegative(),
  projections: z.number().int().nonnegative(), lastEventSeq: z.number().int().nonnegative(),
});
export type GptExtensionSummary = z.infer<typeof gptExtensionSummarySchema>;
