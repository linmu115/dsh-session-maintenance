import { IntegrationError, type CanonicalEndpointSnapshot, type CanonicalSessionRecord } from '@linmu/dsh-session-contracts';
import type { CanonicalSessionEngineStore, CanonicalEngineReceipt } from './engine.js';
import { buildCanonicalVersion } from './codex-observation.js';
import { isDeepStrictEqual } from 'node:util';

/** Canonical, append-preserving reconciliation; no external paths, events or runtime protocols. */
export async function reconcileEndpointSession(store: CanonicalSessionEngineStore, input: CanonicalEndpointSnapshot): Promise<CanonicalEngineReceipt> {
  const current = await store.getSession(input.logicalSessionId);
  if ((current?.headVersionId ?? null) !== input.baseVersionId) throw new IntegrationError('SYNC_STALE_HEAD', '会话版本已更新，请重新读取。');
  if (current?.session.tombstonedAt) throw new IntegrationError('SESSION_DELETED', '已删除会话不能由普通增量自动恢复。');
  if (current && current.session.authorityScope !== 'maintenance') throw new IntegrationError('SYNC_READ_ONLY_SOURCE', '外部真源会话必须通过派生流程续写。');
  const head = input.baseVersionId === null ? undefined : await store.getVersion(input.baseVersionId);
  if (input.baseVersionId !== null && !head) throw new IntegrationError('SYNC_HEAD_MISSING', '会话版本内容缺失。');
  if (head && (input.events.length < head.events.length || head.events.some((event, index) => !isDeepStrictEqual(event, input.events[index]))))
    throw new IntegrationError('SYNC_PREFIX_CHANGED', '已提交历史发生变化，未覆盖真源。');
  const version = buildCanonicalVersion({ logicalSessionId: input.logicalSessionId,
    parentVersionIds: head ? [head.id] : [], events: input.events, workspaceId: input.workspaceId,
    title: input.title, tags: input.tags, archivedAt: input.archivedAt, createdAt: input.observedAt,
    allowForeignEventSessionIds: current?.session.originKind === 'codex-derived' });
  if (head && head.bodyDigest === version.bodyDigest && head.metadataDigest === version.metadataDigest)
    return { outcome: 'noop', logicalSessionId: input.logicalSessionId, versionId: head.id, operationId: null, tombstoneState: null, committedAt: input.observedAt };
  const session: CanonicalSessionRecord = { schemaVersion: 1, id: input.logicalSessionId,
    authorityScope: 'maintenance', originKind: current?.session.originKind ?? 'maintenance-native', headVersionId: version.id,
    title: input.title, tags: [...input.tags], archivedAt: input.archivedAt, tombstonedAt: null,
    createdAt: current?.session.createdAt ?? input.observedAt, updatedAt: input.observedAt };
  const receipt: CanonicalEngineReceipt = { outcome: current ? 'advanced' : 'created', logicalSessionId: input.logicalSessionId,
    versionId: version.id, operationId: null, tombstoneState: null, committedAt: input.observedAt };
  return store.commit({ kind: 'endpoint-sync', operationId: null, session, version,
    membership: { schemaVersion: 1, logicalSessionId: input.logicalSessionId, workspaceId: input.workspaceId,
      displayOrder: current?.displayOrder ?? 0, pinned: current?.pinned ?? false, archived: input.archivedAt !== null, revision: (current?.membershipRevision ?? -1) + 1 },
    derivation: null, projectionReceipt: null, tombstone: null, observation: null, receipt });
}
