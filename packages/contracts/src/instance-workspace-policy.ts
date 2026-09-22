import { z } from "zod";
import type { LogicalSessionId, LogicalWorkspaceId } from "./canonical.js";

/** These identities are keys, not labels or paths; never silently trim them. */
export const instanceWorkspaceInstanceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const identity = z.string().min(1).max(256).refine(value => !/[\s\u0000-\u001f\u007f]/u.test(value), "Identity cannot contain whitespace or control characters");
const workspaceId = identity.transform(value => value as LogicalWorkspaceId);
const sessionId = identity.transform(value => value as LogicalSessionId);
export const instanceWorkspaceSelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({ kind: z.literal("ids"), workspaceIds: z.array(workspaceId).max(10_000)
    .refine(ids => new Set(ids).size === ids.length, "Duplicate workspace identity"), includeUnassigned: z.boolean() }),
]);
export type InstanceWorkspaceSelection = z.infer<typeof instanceWorkspaceSelectionSchema>;
export const instanceWorkspacePolicySchema = z.strictObject({
  schemaVersion: z.literal(1), instanceId: instanceWorkspaceInstanceIdSchema,
  revision: z.number().int().nonnegative(), selection: instanceWorkspaceSelectionSchema,
  updatedAt: z.iso.datetime().nullable(),
});
export type InstanceWorkspacePolicy = z.infer<typeof instanceWorkspacePolicySchema>;
/**
 * The local folders an instance currently owns its mapped buckets under.
 *
 * `sessions` is what makes the folder more than a path: the instance's own workspace registry keeps
 * an ordered membership list, so a folder without its session ids would show up in the instance as
 * an empty workspace. The Engine derives those ids from the folder it just wrote, using the same
 * layout rule it wrote with.
 */
export const instanceWorkspaceFoldersSchema = z.strictObject({
  schemaVersion: z.literal(1), instanceId: instanceWorkspaceInstanceIdSchema,
  folders: z.array(z.strictObject({ name: z.string().min(1).max(200), path: z.string().min(1),
    sessions: z.array(z.string().min(1).max(500)).max(100_000).default([]) })).max(10_000),
});
export type InstanceWorkspaceFolders = z.infer<typeof instanceWorkspaceFoldersSchema>;
export const instanceWorkspacePolicyUpdateSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(), selection: instanceWorkspaceSelectionSchema,
});
export type InstanceWorkspacePolicyUpdate = z.infer<typeof instanceWorkspacePolicyUpdateSchema>;
export const instanceWorkspaceEffectiveScopeSchema = z.strictObject({
  schemaVersion: z.literal(1), instanceId: instanceWorkspaceInstanceIdSchema, profileId: identity,
  policyRevision: z.number().int().nonnegative(), selection: instanceWorkspaceSelectionSchema,
  workspaces: z.array(z.strictObject({ workspaceId, name: z.string(), selected: z.boolean(), deleted: z.boolean() })),
  includeUnassigned: z.boolean(),
});
export type InstanceWorkspaceEffectiveScope = z.infer<typeof instanceWorkspaceEffectiveScopeSchema>;
export const instanceSessionAvailabilitySchema = z.strictObject({
  schemaVersion: z.literal(1), instanceId: instanceWorkspaceInstanceIdSchema, profileId: identity,
  logicalSessionId: sessionId, workspaceId: workspaceId.nullable(), policyRevision: z.number().int().nonnegative(),
  status: z.enum(["available", "not-synced", "offline", "mapping-pending", "deleted", "not-found"]),
  nativeSessionId: identity.nullable(),
}).superRefine((value, ctx) => {
  if (value.status === "available" && value.nativeSessionId === null)
    ctx.addIssue({ code: "custom", path: ["nativeSessionId"], message: "An available session requires a verified native mapping" });
});
export type InstanceSessionAvailability = z.infer<typeof instanceSessionAvailabilitySchema>;
export const instanceWorkspaceConfigurationSchema = z.strictObject({
  policy: instanceWorkspacePolicySchema,
  activeScopes: z.array(z.strictObject({ profileId: identity, runId: identity,
    policyRevision: z.number().int().nonnegative(), selection: instanceWorkspaceSelectionSchema })),
  workspaces: z.array(z.strictObject({ id: workspaceId, name: z.string(), deleted: z.boolean() })),
  pendingActivation: z.boolean(),
  synchronization: z.strictObject({ phase: z.enum(['aligning', 'active', 'blocked']),
    policyRevision: z.number().int().nonnegative(), failures: z.array(z.string()) }).optional(),
});
export type InstanceWorkspaceConfiguration = z.infer<typeof instanceWorkspaceConfigurationSchema>;
/** The provider lists trusted DSH instances, never Codex sources or integration target hashes. */
export const instanceWorkspaceInstanceDirectorySchema = z.strictObject({
  instances: z.array(z.strictObject({ instanceId: instanceWorkspaceInstanceIdSchema, name: z.string().min(1) }))
    .refine(items => new Set(items.map(item => item.instanceId)).size === items.length, "Duplicate instance identity"),
  historicalInstances: z.array(z.strictObject({ instanceId: instanceWorkspaceInstanceIdSchema, name: z.string().min(1) })).optional(),
  notice: z.string().optional(),
}).refine(value => {
  const ids = [...value.instances, ...(value.historicalInstances ?? [])].map(item => item.instanceId);
  return new Set(ids).size === ids.length;
}, "Duplicate instance identity across directories");
export type InstanceWorkspaceInstanceDirectory = z.infer<typeof instanceWorkspaceInstanceDirectorySchema>;
