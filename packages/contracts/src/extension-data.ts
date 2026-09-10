import { z } from "zod";
import { jsonValueSchema } from "./schemas.js";
import type { JsonValue } from "./model.js";

const id = z.string().min(1).max(256);
export const extensionNamespaceSchema = z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/u);
export const extensionScopeSchema = z.strictObject({ instanceId: id, profileId: id, namespace: extensionNamespaceSchema });
export const extensionReferenceSchema = z.strictObject({
  logicalSessionId: id, messageId: id.optional(), anchorId: id.optional(),
  // Future provenance references, never an implicit content snapshot.
  sourceVersion: id.optional(),
});
export const extensionContentSchema = z.strictObject({
  schemaVersion: z.number().int().positive(), title: z.string().max(500),
  body: jsonValueSchema, references: z.array(extensionReferenceSchema).max(500),
});
export const extensionWriteSchema = z.strictObject({
  scope: extensionScopeSchema, objectId: id, writerId: id,
  expectedRevision: z.number().int().nonnegative(),
  content: extensionContentSchema, deleted: z.boolean().default(false),
});
export const extensionConnectSchema = z.strictObject({
  instanceId: id, profileId: id,
  // An authoritative report of the plugins configured on this instance/profile.
  plugins: z.array(z.strictObject({ namespace: extensionNamespaceSchema, pluginVersion: id, writerId: id })).max(100),
});
export const extensionListSchema = z.strictObject({
  ...extensionScopeSchema.shape, after: id.optional(), limit: z.coerce.number().int().min(1).max(100).default(30),
  deleted: z.enum(["active", "deleted", "all"]).default("active"),
});
export type ExtensionScope = z.infer<typeof extensionScopeSchema>;
export type ExtensionReference = z.infer<typeof extensionReferenceSchema>;
export type ExtensionContent = z.infer<typeof extensionContentSchema>;
export type ExtensionWrite = z.infer<typeof extensionWriteSchema>;
export type ExtensionConnect = z.infer<typeof extensionConnectSchema>;
export type ExtensionList = z.input<typeof extensionListSchema>;
export interface ExtensionMetadata {
  scope: ExtensionScope; objectId: string; writerId: string; revision: number; schemaVersion: number;
  title: string; deleted: boolean; updatedAt: string; bytes: number; conflicts: number;
}
export interface ExtensionObject extends ExtensionMetadata { content: ExtensionContent }
export interface ExtensionConflict {
  id: string; objectId: string; createdAt: string; expectedRevision: number;
  current: ExtensionObject; incoming: ExtensionWrite;
}
export type ExtensionWriteResult = { status: "saved" | "unchanged"; object: ExtensionObject }
  | { status: "conflict"; conflict: ExtensionConflict };
export interface ExtensionPage { items: ExtensionMetadata[]; nextCursor: string | null }
export type ExtensionPreview = { kind:"graph"; nodes:{id:string;label:string;x:number;y:number}[]; edges:{source:string;target:string}[]; total:number }
  | {kind:"rows";rows:{label:string;text:string}[];total:number};
export interface ExtensionDetail { object: ExtensionObject; summary: string; conflictIds: string[]; preview?: ExtensionPreview }
export interface ExtensionPanel {
  scope: ExtensionScope; label: string; pluginVersion: string; writerId: string;
  configured: boolean; enabled: boolean; status: "ready" | "disabled" | "missing-adapter" | "incompatible";
  objectCount: number; conflictCount: number; bytes: number;
  capabilities: ExtensionCapabilities | null;
}
export interface ExtensionCapabilities { read: boolean; write: boolean; delete: boolean; restore: boolean; panel: boolean; context: false }
/** Trusted code registration; plugin payloads never install executable adapters. */
export interface ExtensionDataAdapter {
  namespace: string; label: string; pluginVersions: readonly string[]; schemaVersions: readonly number[];
  capabilities: ExtensionCapabilities;
  validate(content: ExtensionContent): void;
  summarize(body: JsonValue): string;
  preview?(body: JsonValue): ExtensionPreview;
}
export class ExtensionDataError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
