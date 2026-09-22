import { z } from 'zod';
import { canonicalEventV1Schema, canonicalSessionRecordSchema, logicalWorkspaceSchema, jsonValueSchema } from './schemas.js';
import type { CanonicalProjectionInput } from './adapter-sdk.js';
import type { WorkspaceWriteBackSummary } from './workspace-sync.js';
import { pluginDataRecordSchema } from './plugin-data-mapping.js';

const id = z.string().min(1).max(512);
export const hostPluginDataCaptureSchema = z.strictObject({ schemaVersion: z.literal(1), instanceId: id, profileId: id,
  pid: z.number().int().positive(), processStartedAt: id, homeRoot: id, sessionId: id });
export const hostWorkspaceSyncSchema = z.strictObject({
  schemaVersion: z.literal(1), operationId: id, instanceId: id, profileId: id,
  pid: z.number().int().positive(), processStartedAt: id, homeRoot: id,
  workspaceRoot: z.string().min(1).max(4096),
  selection: z.strictObject({ revision: z.number().int().nonnegative(), selection: z.union([
    z.strictObject({ kind: z.literal('all') }),
    z.strictObject({ kind: z.literal('ids'), workspaceIds: z.array(id), includeUnassigned: z.boolean() }),
  ]) }),
  workspaceNames: z.array(z.tuple([id, z.string().max(500)])),
  projection: z.strictObject({
    run: z.object({ id, instanceId: id, profileId: id }).passthrough(),
    workspaces: z.array(logicalWorkspaceSchema),
    sessions: z.array(z.object({ session: canonicalSessionRecordSchema, events: z.array(canonicalEventV1Schema), workspaceId: id.nullable(),
      projectId: id.nullable().optional(), projectName: z.string().nullable().optional(), projectRoot: z.string().nullable().optional(),
      nativeSourceExports: z.array(jsonValueSchema).optional(), pluginData: z.array(pluginDataRecordSchema).optional(),
    }).strict()),
  }),
});
export type HostWorkspaceSyncRequest = Omit<z.infer<typeof hostWorkspaceSyncSchema>, 'projection'> & { projection: CanonicalProjectionInput };
export interface HostWorkspaceSyncReceipt {
  schemaVersion: 1; operationId: string; instanceId: string; profileId: string; pid: number; processStartedAt: string;
  summary: WorkspaceWriteBackSummary;
  bindings: { nativeSessionId: string; logicalSessionId: string }[];
}

const count = z.number().int().nonnegative();
export const hostWorkspaceSyncReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1), operationId: id, instanceId: id, profileId: id,
  pid: z.number().int().positive(), processStartedAt: id,
  summary: z.strictObject({ written: count, unchanged: count, skippedOutOfScope: count,
    failures: z.array(z.string()), workspaceFolders: z.array(z.string()).optional(),
    pluginData: z.strictObject({ restored: count, retained: count }).optional(),
  }),
  bindings: z.array(z.strictObject({ nativeSessionId: id, logicalSessionId: id })),
});
