import { z } from "zod";
const id = z.string().min(1).max(256);
export const vaultBindingTargetSchema = z.strictObject({ instanceId: id, profileId: id });
export const vaultBindingInstanceSchema = vaultBindingTargetSchema.extend({ name: z.string() });
export const vaultBindingInstancesSchema = z.array(vaultBindingInstanceSchema);
export const vaultBindingSnapshotSchema = z.strictObject({ bindingProtocolVersion: z.literal(1), vaultId: id, revision: z.number().int().nonnegative(), target: vaultBindingTargetSchema.nullable(), updatedAt: z.number().int().nonnegative(), lastOperationId: id.optional() });
export const managedVaultSchema = z.strictObject({ vaultId: id, name: z.string(), root: z.string(), revision: z.number().int().nonnegative(), online: z.boolean(), manageable: z.boolean() });
export const managedVaultsSchema = z.array(managedVaultSchema);
export const vaultBindingActionSchema = vaultBindingTargetSchema.extend({ operationId: z.uuid(), vaultId: id.optional(), expectedRevision: z.number().int().nonnegative().optional() });
export const vaultBindingResultSchema = z.strictObject({ message: z.string(), cancelled: z.boolean().optional() });
/** A short-lived grant signed by the local Engine. It authorizes binding only, never a runtime controller lease. */
export const vaultBindingGrantSchema = z.strictObject({ domain: z.literal("maintenance-vault-binding-v1"), operationId: z.uuid(), vaultId: id, bootId: z.uuid(), publisherId: z.uuid(), instanceId: id, profileId: id, expectedRevision: z.number().int().nonnegative(), intent: z.enum(["bind", "unbind"]), expiresAt: z.number().int().positive() });
export type VaultBindingInstance = z.infer<typeof vaultBindingInstanceSchema>;
export type ManagedVault = z.infer<typeof managedVaultSchema>;
export type VaultBindingAction = z.infer<typeof vaultBindingActionSchema>;
export type VaultBindingGrant = z.infer<typeof vaultBindingGrantSchema>;
