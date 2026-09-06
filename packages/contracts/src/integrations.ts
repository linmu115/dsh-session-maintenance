import { z } from "zod";

const id = z.string().min(1).max(256);
export const integrationCapabilitySchema = z.strictObject({
  id, label: z.string(), status: z.enum(["supported", "unavailable", "unchecked"]), detail: z.string(),
});
export const integrationTargetSchema = z.strictObject({
  id, kind: z.enum(["dsh", "codex"]), name: z.string(), version: z.string(), profile: z.string().nullable(),
  status: z.enum(["available", "connected", "needs-attention", "unsupported"]), adapterId: z.string().nullable(),
  capabilities: z.array(integrationCapabilitySchema), issues: z.array(z.string()),
});
export const integrationDirectorySchema = z.strictObject({
  targets: z.array(integrationTargetSchema), launcherDetected: z.boolean(),
  nativeSyncSupported: z.literal(false), nativeSyncReason: z.string(),
});
export const integrationActionSchema = z.enum(["connect", "check", "repair", "disconnect"]);
export const integrationActionRequestSchema = z.strictObject({ targetId: id, action: integrationActionSchema });
export type IntegrationCapability = z.infer<typeof integrationCapabilitySchema>;
export type IntegrationTarget = z.infer<typeof integrationTargetSchema>;
export type IntegrationDirectory = z.infer<typeof integrationDirectorySchema>;
export type IntegrationAction = z.infer<typeof integrationActionSchema>;

export const workspaceSyncPolicySchema = z.strictObject({
  revision: z.number().int().nonnegative(), workspaceIds: z.array(id).max(10_000),
  includeFutureSessions: z.literal(true), nativeWriteEnabled: z.literal(false),
});
export const syncWorkspaceSchema = z.strictObject({
  id, name: z.string(), roots: z.array(z.string()), sessionCount: z.number().int().nonnegative(),
  eligible: z.boolean(), reason: z.string(),
});
export const workspaceSyncConfigurationSchema = z.strictObject({
  policy: workspaceSyncPolicySchema, workspaces: z.array(syncWorkspaceSchema),
  nativeSyncSupported: z.literal(false), nativeSyncReason: z.string(),
});
export const workspaceSyncUpdateSchema = z.strictObject({
  revision: z.number().int().nonnegative(), workspaceIds: z.array(id).max(10_000),
});
export type WorkspaceSyncPolicy = z.infer<typeof workspaceSyncPolicySchema>;
export type SyncWorkspace = z.infer<typeof syncWorkspaceSchema>;
export type WorkspaceSyncConfiguration = z.infer<typeof workspaceSyncConfigurationSchema>;
export type WorkspaceSyncUpdate = z.infer<typeof workspaceSyncUpdateSchema>;

export const CODEX_NATIVE_SYNC_UNAVAILABLE = "当前 Codex 接口尚未通过原生对话写入与页面加载验证。工作区名单可以保存，暂不执行 Codex 回写。";
