import { z } from "zod";
import type { ExtensionMetadata, ExtensionPanel } from "./extension-data.js";

const id = z.string().min(1).max(256);
export const EXTENSION_UNBOUND = "@unbound";
export const EXTENSION_UNGROUPED = "@ungrouped";
export const extensionBusinessPanelQuerySchema = z.strictObject({ instanceId: id.optional(), profileId: id.optional() });
export type ExtensionBusinessPanelQuery = z.infer<typeof extensionBusinessPanelQuerySchema>;
export interface ExtensionBusinessPanel {
  adapterId: string; label: string; scope: { instanceId: string; profileId: string };
  instanceLabel: string; profileLabel: string;
  status: ExtensionPanel["status"] | "partial"; members: ExtensionPanel[];
  objectCount: number; conflictCount: number; bytes: number;
}
export const extensionDirectoryQuerySchema = z.strictObject({
  instanceId: id, profileId: id, adapterId: id,
  level: z.enum(["workspaces", "sessions", "objects"]),
  workspaceId: id.optional(), ownerSessionId: id.optional(), parentObjectId: id.optional(),
  after: z.string().max(4096).optional(), limit: z.coerce.number().int().min(1).max(100).default(30),
  deleted: z.enum(["active", "deleted", "all"]).default("active"),
}).superRefine((q, ctx) => {
  if (q.level === "sessions" && !q.workspaceId) ctx.addIssue({ code: "custom", message: "会话目录需要工作区身份" });
  if (q.level === "objects" && !q.ownerSessionId) ctx.addIssue({ code: "custom", message: "对象目录需要所属会话身份" });
  if (q.parentObjectId && q.level !== "objects") ctx.addIssue({ code: "custom", message: "附属对象仅可在对象目录查询" });
});
export type ExtensionDirectoryQuery = z.input<typeof extensionDirectoryQuerySchema>;
export interface ExtensionDirectoryGroup {
  type: "workspace" | "session"; id: string; label: string; count: number;
  ownerSessionId?: string | null; archived: boolean; archivedAt: string | null; missing: boolean;
}
export interface ExtensionDirectoryObject extends ExtensionMetadata {
  type: "object"; id: string; label: string; count: number;
  ownerSessionId: string | null; kind: string; parentObjectId: string | null;
  readOnly: boolean; unavailableReason: string | null; ownershipReason: string | null;
  archived: boolean; archivedAt: string | null; missing: boolean;
}
export interface ExtensionDirectoryPage {
  level: "workspaces" | "sessions" | "objects";
  items: Array<ExtensionDirectoryGroup | ExtensionDirectoryObject>; nextCursor: string | null;
}
/** Produced by trusted Adapter code. Related sessions are never inferred as owners. */
export interface ExtensionObjectOwnership {
  ownerSessionId: string | null; kind: string; parentObjectId?: string | null;
  readOnly?: boolean; reason?: string | null;
  canonicalReferenceId?: string | null;
}

export const ANNOTATION_RECORDS_NAMESPACE = "annotation-records";
const source = z.strictObject({
  nativeSessionId: id.optional(), title: z.string().max(500).optional(),
  upstreamReferenceId: id.optional(),
  vaultId: id.optional(), noteId: id.optional(), notePath: z.string().max(2048).optional(), anchorId: id.optional(),
});
export const annotationMirrorEntrySchema = z.strictObject({
  referenceId: id, setId: id, sourceType: z.enum(["dsh-message", "obsidian-note"]),
  state: z.enum(["pending", "committing", "sent", "failed", "deleted"]),
  selectedText: z.string().max(4000), userComment: z.string().max(2000),
  source, truncated: z.boolean().optional(),
});
export const annotationMirrorRecordSchema = annotationMirrorEntrySchema.extend({
  kind: z.literal("reference-record"), targetSessionId: id, sourceRevision: z.number().int().nonnegative(),
  source: source.extend({ logicalSessionId: id.optional() }),
});
export const annotationMirrorSyncSchema = z.strictObject({
  runId: id, nativeSessionId: id, sourceRevision: z.number().int().nonnegative(),
  entries: z.array(annotationMirrorEntrySchema).min(1).max(50),
}).superRefine((q, ctx) => {
  if (new Set(q.entries.map(entry => entry.referenceId)).size !== q.entries.length)
    ctx.addIssue({ code: "custom", message: "引用同步页不能包含重复身份" });
});
export type AnnotationMirrorSync = z.infer<typeof annotationMirrorSyncSchema>;
export type AnnotationMirrorRecord = z.infer<typeof annotationMirrorRecordSchema>;
export interface AnnotationMirrorReceipt {
  referenceId: string; objectId: string; revision: number; sourceRevision: number;
  status: "saved" | "unchanged" | "stale" | "conflict" | "deferred"; reason?: string;
}
export interface AnnotationMirrorSyncResult { items: AnnotationMirrorReceipt[] }
