import type { CanonicalEventV1, NativeSessionId, LogicalSessionId, LogicalWorkspaceId, SessionVersionId } from './index.js';
import { z } from 'zod';

export const endpointSyncStatusSchema = z.strictObject({
  epoch: z.string().min(1),
  phase: z.enum(['aligning', 'active', 'blocked']),
  policyRevision: z.number().int().nonnegative(),
});
export type EndpointSyncStatus = z.infer<typeof endpointSyncStatusSchema>;
export const endpointSyncCommandSchema = z.strictObject({
  epoch: z.string().min(1), profileId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(512),
  change: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('archive'), archived: z.boolean() }),
    z.strictObject({ kind: z.literal('delete') }),
    z.strictObject({ kind: z.literal('refresh') }),
  ]),
});
export type EndpointSyncCommand = z.infer<typeof endpointSyncCommandSchema>;

export interface EndpointSyncReceipt {
  readonly epoch: string;
  readonly logicalSessionId: string | null;
  readonly outcome: 'updated' | 'deleted' | 'pending-delete' | 'out-of-scope';
  readonly archived?: boolean;
  readonly pendingOperations?: number;
}

/** An adapter has validated the external prefix; only canonical events enter the core. */
export interface CanonicalEndpointSnapshot {
  readonly logicalSessionId: LogicalSessionId;
  readonly baseVersionId: SessionVersionId | null;
  readonly events: readonly CanonicalEventV1[];
  readonly title: string;
  readonly tags: readonly string[];
  readonly archivedAt: string | null;
  readonly workspaceId: LogicalWorkspaceId | null;
  readonly observedAt: string;
}

/** Logical synchronization results. No host layout, plugin API or process identity is needed. */
export interface WorkspaceWriteBackSummary {
  readonly pluginData?: { readonly restored: number; readonly retained: number };
  readonly written: number;
  readonly unchanged: number;
  readonly skippedOutOfScope: number;
  readonly failures: readonly string[];
  readonly workspaceFolders?: readonly string[];
}

export interface MappedNativeSession {
  readonly nativeSessionId: NativeSessionId;
  readonly title: string;
  readonly tags: readonly string[];
  readonly archivedAt: string | null;
  readonly events: readonly CanonicalEventV1[];
}

export interface JoinedWorkspaceSource {
  list(): Promise<readonly NativeSessionId[]>;
  read(nativeSessionId: NativeSessionId): Promise<MappedNativeSession>;
}

export interface RegisteredWorkspaceFolder {
  readonly name: string;
  readonly path: string;
  readonly sessions?: readonly string[];
}

/** The adapter resolves physical folders; the core only supplies its logical selection. */
export interface WorkspaceFolderAdapter {
  list(input: { readonly endpointId: string; readonly buckets: readonly { readonly workspaceId: string; readonly name: string }[] }): Promise<readonly RegisteredWorkspaceFolder[]>;
}
