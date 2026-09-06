import { z } from "zod";

const key = z.string().min(1).max(1024);
export const codexProjectMappingPolicySchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  activeRevision: z.number().int().nonnegative(),
  configured: z.boolean(),
  activeConfigured: z.boolean(),
  projectKeys: z.array(key).max(10_000),
  activeProjectKeys: z.array(key).max(10_000),
  includeFutureSessions: z.literal(true),
});
export const codexProjectMappingUpdateSchema = z.strictObject({
  revision: z.number().int().nonnegative(), projectKeys: z.array(key).max(10_000),
});
export const codexMappingProjectSchema = z.strictObject({
  key, instanceId: key, projectId: key, name: z.string(),
  roots: z.array(z.string()), sessionCount: z.number().int().nonnegative(),
  kind: z.enum(["local", "mixed", "unknown"]), eligible: z.boolean(), issues: z.array(z.string()),
});
export const codexProjectMappingConfigurationSchema = z.strictObject({
  policy: codexProjectMappingPolicySchema,
  projects: z.array(codexMappingProjectSchema),
  issues: z.array(z.string()),
  pendingActivation: z.boolean(),
  observer: z.strictObject({
    state: z.enum(["stopped", "idle", "syncing", "error"]),
    lastSyncAt: z.string().nullable(), lastError: z.string().nullable(),
  }),
});
export type CodexProjectMappingPolicy = z.infer<typeof codexProjectMappingPolicySchema>;
export type CodexProjectMappingUpdate = z.infer<typeof codexProjectMappingUpdateSchema>;
export type CodexMappingProject = z.infer<typeof codexMappingProjectSchema>;
export type CodexProjectMappingConfiguration = z.infer<typeof codexProjectMappingConfigurationSchema>;
