import { createHash } from 'node:crypto';
import type {
  CanonicalEventV1, LogicalSessionId, LogicalWorkspace, LogicalWorkspaceId, NativeSessionId, OperationId,
} from '@linmu/dsh-session-contracts';
import type { CanonicalSessionEngine } from '@linmu/dsh-canonical-session-engine';

/**
 * Mapping a joined workspace into Maintenance's own session storage.
 *
 * Maintenance keeps its own sessions as structured canonical rows — a workspace
 * is a *folder* in that store, which is a row in the workspace table plus the
 * memberships of the sessions inside it. No physical directory is created for
 * it: the user's "folder" is the board's grouping, and the sessions themselves
 * are the canonical records. The instance's own directory layout is never the
 * maintenance store.
 *
 * Joining is a one-off act by an operator, so it maps every session the
 * workspace already has; everything after that arrives through the ordinary
 * incremental path, which is why this never re-maps a session it already knows.
 */

/** One native session read from the instance, ready to become a canonical row. */
import type { JoinedWorkspaceSource } from '@linmu/dsh-session-contracts';
export type { JoinedWorkspaceSource, MappedNativeSession } from '@linmu/dsh-session-contracts';

export interface WorkspaceMappingReceipt {
  readonly workspaceId: LogicalWorkspaceId;
  /** The workspace folder's row, created by this call or already present. */
  readonly created: boolean;
  readonly mapped: readonly LogicalSessionId[];
  /** Sessions that were already canonical and therefore left untouched. */
  readonly alreadyPresent: readonly NativeSessionId[];
  readonly failures: readonly { readonly nativeSessionId: string; readonly reason: string }[];
}

/**
 * The canonical session identity for one native session of an instance.
 *
 * It is derived from the instance and the native session, so mapping the same
 * session twice resolves to the same canonical session instead of creating a
 * second one; this is what makes joining idempotent for the sessions it already
 * mapped.
 */
export function mappedLogicalSessionId(instanceId: string, nativeSessionId: string): LogicalSessionId {
  return `logical-dsh-${createHash('sha256').update(`${instanceId}\0${nativeSessionId}`).digest('hex').slice(0, 32)}` as LogicalSessionId;
}

/** The operation name for one mapping, so a retry of the same join is a no-op. */
export function joinWorkspaceOperationId(instanceId: string, workspaceId: string, nativeSessionId: string): OperationId {
  return `join-workspace-${createHash('sha256')
    .update(`${instanceId}\0${workspaceId}\0${nativeSessionId}`).digest('hex').slice(0, 32)}` as OperationId;
}

/** The workspace folder row for a joined workspace; the id is derived, never random. */
export function joinedWorkspaceId(instanceId: string, workspaceKey: string): LogicalWorkspaceId {
  return `workspace-joined-${createHash('sha256').update(`${instanceId}\0${workspaceKey}`).digest('hex').slice(0, 32)}` as LogicalWorkspaceId;
}

export interface MapJoinedWorkspaceInput {
  readonly capturePluginData?: (nativeSessionId: string, logicalSessionId: string) => Promise<void>;
  readonly bindIdentity?: (nativeSessionId: string, logicalSessionId: string, checkOnly: boolean) => Promise<void>;
  readonly engine: Pick<CanonicalSessionEngine, 'importDshNative' | 'store'>;
  /** Reads a workspace folder row and writes it back; the canonical repository provides this. */
  readonly workspaces: {
    read(id: LogicalWorkspaceId): Promise<LogicalWorkspace | undefined>;
    upsert(workspace: LogicalWorkspace): Promise<void>;
  };
  readonly source: JoinedWorkspaceSource;
  readonly instanceId: string;
  /** Stable identity of the joined workspace within this instance (its project id). */
  readonly workspaceKey: string;
  readonly workspaceName: string;
  readonly clock?: () => string;
}

/**
 * Create the workspace's folder in Maintenance's store and map its sessions.
 *
 * Everything already mapped is skipped — the import is keyed by a deterministic
 * operation id, and a session whose canonical record exists is reported rather
 * than replaced. A session that cannot be read is reported as a failure and the
 * rest of the workspace still maps, because one unreadable session must not deny
 * the operator the rest of the join.
 */
export async function mapJoinedWorkspace(input: MapJoinedWorkspaceInput): Promise<WorkspaceMappingReceipt> {
  const clock = input.clock ?? (() => new Date().toISOString());
  const workspaceId = joinedWorkspaceId(input.instanceId, input.workspaceKey);
  const existing = await input.workspaces.read(workspaceId);
  const now = clock();
  if (existing === undefined) {
    await input.workspaces.upsert({ schemaVersion: 1, id: workspaceId, parentId: null, name: input.workspaceName,
      sortKey: input.workspaceName, deletedAt: null, createdAt: now, updatedAt: now });
  }

  const mapped: LogicalSessionId[] = [];
  const alreadyPresent: NativeSessionId[] = [];
  const failures: { nativeSessionId: string; reason: string }[] = [];
  for (const nativeSessionId of await input.source.list()) {
    const logicalSessionId = mappedLogicalSessionId(input.instanceId, String(nativeSessionId));
    try {
      await input.bindIdentity?.(String(nativeSessionId), String(logicalSessionId), true);
      // Already canonical means already mapped; the import is keyed by a
      // deterministic operation id, so a retry finds the same session instead of
      // creating a second row for it.
      if (await input.engine.store.getSession(logicalSessionId) !== undefined) {
        await input.capturePluginData?.(String(nativeSessionId), String(logicalSessionId));
        await input.bindIdentity?.(String(nativeSessionId), String(logicalSessionId), false);
        alreadyPresent.push(nativeSessionId); continue;
      }
      const session = await input.source.read(nativeSessionId);
      await input.engine.importDshNative({ operationId: joinWorkspaceOperationId(input.instanceId, workspaceId, String(nativeSessionId)),
        logicalSessionId, nativeSessionId, title: session.title, tags: [...session.tags], archivedAt: session.archivedAt,
        workspaceId, events: session.events, importedAt: clock() });
      await input.bindIdentity?.(String(nativeSessionId), String(logicalSessionId), false);
      await input.capturePluginData?.(String(nativeSessionId), String(logicalSessionId));
      mapped.push(logicalSessionId);
    } catch (error) {
      failures.push({ nativeSessionId: String(nativeSessionId), reason: error instanceof Error ? error.message : String(error) });
    }
  }
  // A later join of the same workspace refreshes the folder's label without moving sessions.
  if (existing !== undefined && existing.name !== input.workspaceName) {
    await input.workspaces.upsert({ ...existing, name: input.workspaceName, updatedAt: now });
  }
  return { workspaceId, created: existing === undefined, mapped, alreadyPresent, failures };
}
