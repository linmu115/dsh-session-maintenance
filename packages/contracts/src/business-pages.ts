import { z } from "zod";
import { extensionScopeSchema } from "./extension-data.js";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const label = z.string().min(1).max(200);
export const businessPageOwnerSchema = extensionScopeSchema.extend({ providerId: id, bootId: z.uuid() }).strict();
export type BusinessPageOwner = z.infer<typeof businessPageOwnerSchema>;
const fieldBase = { id, label, required: z.boolean() };
export const businessPageFieldSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...fieldBase, kind: z.literal("text") }),
  z.strictObject({ ...fieldBase, kind: z.literal("boolean") }),
  z.strictObject({ ...fieldBase, kind: z.literal("integer") }),
  z.strictObject({ ...fieldBase, kind: z.literal("select"), options: z.array(z.strictObject({ value: z.string().min(1).max(200), label })).min(1).max(64) }),
]);
export const businessPageActionDescriptorSchema = z.strictObject({ id, label, expectedRevision: z.number().int().nonnegative(),
  fields: z.array(businessPageFieldSchema).max(16).refine(fields => new Set(fields.map(field => field.id)).size === fields.length, "Duplicate action field") });
export type BusinessPageActionDescriptor = z.infer<typeof businessPageActionDescriptorSchema>;
const sectionBase = { id, title: label };
export const businessPageSnapshotSchema = z.strictObject({ title: label, revision: z.number().int().nonnegative(), sections: z.array(z.discriminatedUnion("kind", [
  z.strictObject({ ...sectionBase, kind: z.literal("summary"), text: z.string().max(4000) }),
  z.strictObject({ ...sectionBase, kind: z.literal("status"), label, state: z.enum(["ready", "warning", "unavailable"]) }),
  z.strictObject({ ...sectionBase, kind: z.literal("key-values"), items: z.array(z.strictObject({ label, value: z.string().max(2000) })).max(40) }),
  z.strictObject({ ...sectionBase, kind: z.literal("data-directory"), adapterId: id }),
  z.strictObject({ ...sectionBase, kind: z.literal("actions"), actions: z.array(businessPageActionDescriptorSchema).max(16) }),
])).max(24) }).superRefine((snapshot, context) => {
  const sectionIds = snapshot.sections.map(section => section.id);
  const actionIds = snapshot.sections.flatMap(section => section.kind === "actions" ? section.actions.map(action => action.id) : []);
  if (new Set(sectionIds).size !== sectionIds.length || new Set(actionIds).size !== actionIds.length)
    context.addIssue({ code: "custom", message: "Section and action identities must be unique" });
  if (JSON.stringify(snapshot).length > 32768) context.addIssue({ code: "custom", message: "Business page snapshot is too large" });
});
export type BusinessPageSnapshot = z.infer<typeof businessPageSnapshotSchema>;
export const businessPageRegistrationSchema = z.strictObject({ owner: businessPageOwnerSchema, snapshot: businessPageSnapshotSchema });
export type BusinessPageRegistration = z.infer<typeof businessPageRegistrationSchema>;
export const businessPageActionRequestSchema = z.strictObject({ owner: businessPageOwnerSchema, operationId: z.uuid(), actionId: id,
  expectedRevision: z.number().int().nonnegative(), input: z.record(id, z.union([z.string().max(2048), z.number().int().min(-1e12).max(1e12), z.boolean()]))
    .refine(input => Object.keys(input).length <= 16, "Too many action fields") });
export type BusinessPageActionRequest = z.infer<typeof businessPageActionRequestSchema>;
export const businessPageActionResultSchema = z.strictObject({ message: z.string().max(4000) });
export type BusinessPageActionResult = z.infer<typeof businessPageActionResultSchema>;
export const businessPageActionReceiptSchema = z.strictObject({ request: businessPageActionRequestSchema,
  status: z.enum(["queued", "running", "completed", "failed", "uncertain"]), message: z.string().max(4000), updatedAt: z.number().nonnegative() });
export type BusinessPageActionReceipt = z.infer<typeof businessPageActionReceiptSchema>;
export const businessPageSchema = businessPageRegistrationSchema.extend({ online: z.boolean(), updatedAt: z.number().nonnegative(), expiresAt: z.number().nonnegative() });
export type BusinessPage = z.infer<typeof businessPageSchema>;
export const businessPageDirectorySchema = z.strictObject({ pages: z.array(businessPageSchema).max(500) });
export const businessPageActionAckSchema = z.strictObject({ owner: businessPageOwnerSchema, operationId: z.uuid(), status: z.enum(["completed", "failed"]), message: z.string().max(4000) });
export type BusinessPageActionAck = z.infer<typeof businessPageActionAckSchema>;
