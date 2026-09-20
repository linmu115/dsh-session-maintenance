import { z } from 'zod';
export const codexMirrorPreferencesSchema = z.object({
  mirror: z.boolean().default(false), bidirectional: z.boolean().default(false), background: z.boolean().default(false),
  executable: z.string().max(2000).default(''), instanceId: z.string().max(256).default(''),
}).strict();
export type CodexMirrorPreferences = z.infer<typeof codexMirrorPreferencesSchema>;
export interface CodexMirrorCheck { compatible: boolean; version?: string; reason: string; bidirectional: boolean; }
export interface CodexMirrorStatus { preferences: CodexMirrorPreferences; check: CodexMirrorCheck | null; active: { mirror: boolean; bidirectional: boolean; background: boolean }; }
