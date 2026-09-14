import { z } from 'zod';
import { jsonValueSchema } from './schemas.js';
import type { ExtensionObject } from './extension-data.js';

const id = z.string().min(1).max(256);
export const noteIdentitySchema = z.strictObject({
  vaultId: id, noteId: id, notePath: z.string().min(1).max(2048),
  blockId: id.optional(), heading: z.string().max(500).optional(),
});
export const noteSelectionSchema = z.strictObject({
  selectedText: z.string().min(1).max(16000),
  selectedTextHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  occurrence: z.number().int().nonnegative(),
});
export const sessionStickerSchema = z.strictObject({
  kind: z.literal('session'), logicalSessionId: id,
  source: z.strictObject({ logicalSessionId: id, sourceVersionId: id, sourceAnchorId: id, referenceId: id.optional(),
    locator: z.strictObject({ messageId: id, selectedText: z.string().min(1).max(4000), occurrence: z.number().int().nonnegative() }).optional(),
  }).optional(),
  note: noteIdentitySchema.optional(),
  noteSelection: noteSelectionSchema.optional(),
}).superRefine((value, context) => {
  if (value.noteSelection && !value.note) context.addIssue({code:'custom',message:'笔记选段必须包含稳定笔记身份'});
});
export const legacyStickerSchema = z.strictObject({
  kind: z.literal('annotation'), logicalSessionId: id, legacyStickerId: id,
  record: jsonValueSchema, migrationId: id.optional(),
});
export const knowledgeLinkSchema = z.strictObject({
  kind: z.literal('note-link'), note: noteIdentitySchema, logicalSessionId: id,
  syncState: z.enum(['pending', 'synced', 'missing', 'ambiguous']), legacyReferenceId: id.optional(),
});
export const stickerMigrationSchema = z.strictObject({
  kind: z.literal('migration'), migrationId: id, vaultId: id, legacySessionId: id, logicalSessionId: id,
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), sourceRevision: id,
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  phase: z.enum(['staged', 'active']), mappings: z.array(z.strictObject({ legacyId: id, objectId: id })).max(500),
  pendingBacklinkDeletes: z.array(jsonValueSchema).max(500).default([]),
});
export const stickerObjectSchema = z.union([sessionStickerSchema, legacyStickerSchema, stickerMigrationSchema]);
export const knowledgeNamespaceSchema = z.enum(['stickers', 'obsidian-links']);
export const knowledgeWriteSchema = z.strictObject({
  namespace: knowledgeNamespaceSchema, objectId: id, expectedRevision: z.number().int().nonnegative(),
  title: z.string().min(1).max(500), body: z.union([sessionStickerSchema, legacyStickerSchema, knowledgeLinkSchema]),
  deleted: z.boolean().default(false),
});
export const knowledgeListSchema = z.strictObject({
  namespace: knowledgeNamespaceSchema, logicalSessionId: id.optional(), after: id.optional(),
  deleted: z.enum(['active', 'deleted', 'all']).default('active'),
});
export const knowledgeMigrationSchema = z.strictObject({
  migrationId: id, vaultId: id, nativeSessionId: id, sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRevision: id, phase: z.enum(['stage', 'activate']),
  stickers: z.array(z.strictObject({ legacyId: id, title: z.string().max(500), record: jsonValueSchema })).max(500),
  pendingBacklinkDeletes: z.array(jsonValueSchema).max(500).default([]),
});
export type NoteIdentity = z.infer<typeof noteIdentitySchema>;
export type NoteSelection = z.infer<typeof noteSelectionSchema>;
export type SessionSticker = z.infer<typeof sessionStickerSchema>;
export type KnowledgeLink = z.infer<typeof knowledgeLinkSchema>;
export type KnowledgeWrite = z.input<typeof knowledgeWriteSchema>;
export type KnowledgeList = z.input<typeof knowledgeListSchema>;
export type KnowledgeMigration = z.input<typeof knowledgeMigrationSchema>;
export interface KnowledgeMigrationReceipt {
  object: ExtensionObject;
  mappings: Array<{legacyId:string;objectId:string}>;
  /** A legacy receipt acknowledges only its prior activation, not the new payload. */
  verification: 'manifest-verified' | 'legacy-receipt-only';
}
export type KnowledgePage = { items: ExtensionObject[]; nextCursor: string | null };
