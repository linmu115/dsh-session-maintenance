import { z } from 'zod';
import { jsonValueSchema } from './schemas.js';
import type { ExtensionObject } from './extension-data.js';

const id = z.string().min(1).max(256);
export const noteIdentitySchema = z.strictObject({
  vaultId: id, noteId: id, notePath: z.string().min(1).max(2048),
  blockId: id.optional(), heading: z.string().max(500).optional(),
});
export const sessionStickerSchema = z.strictObject({
  kind: z.literal('session'), logicalSessionId: id,
  source: z.strictObject({ logicalSessionId: id, sourceVersionId: id, sourceAnchorId: id, referenceId: id.optional() }).optional(),
  note: noteIdentitySchema.optional(),
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
export const networkQuerySchema = z.strictObject({
  query: z.string().max(200).default(''), after: z.string().max(2048).optional(),
  kind: z.enum(['all', 'session', 'canvas', 'sticker', 'note']).default('all'),
  includeDeleted: z.boolean().default(false),
});
export const networkImpactSchema = z.strictObject({ logicalSessionId: id, depth: z.number().int().min(1).max(8).default(4) });
export type NoteIdentity = z.infer<typeof noteIdentitySchema>;
export type SessionSticker = z.infer<typeof sessionStickerSchema>;
export type KnowledgeLink = z.infer<typeof knowledgeLinkSchema>;
export type KnowledgeWrite = z.input<typeof knowledgeWriteSchema>;
export type KnowledgeList = z.input<typeof knowledgeListSchema>;
export type KnowledgeMigration = z.input<typeof knowledgeMigrationSchema>;
export type KnowledgePage = { items: ExtensionObject[]; nextCursor: string | null };
export interface NetworkItem {
  key: string; kind: 'session' | 'canvas' | 'sticker' | 'note'; title: string;
  logicalSessionIds: string[]; namespace?: string; objectId?: string; revision?: number;
  deleted: boolean; conflicts: number; available: boolean;
}
export interface NetworkPage { items: NetworkItem[]; nextCursor: string | null }
export interface NetworkImpact {
  sourceLogicalSessionId: string; visited: number; truncated: boolean;
  items: Array<{ referenceId: string; sourceSessionId: string; targetSessionId: string; title: string;
    sourceVersionId: string; currentSourceVersionId: string | null; sourceAnchorId: string;
    status: 'fixed' | 'new-content' | 'source-unavailable'; depth: number }>;
}
