import { expect, it } from 'vitest';
import { reconcileEndpointSession } from '@linmu/dsh-canonical-session-engine';
import { packOpaqueEvents, type CanonicalEventV1, type LogicalSessionId } from '@linmu/dsh-session-contracts';
import { createEngineFixture } from './helpers.js';
import { SessionLifecycle } from '../src/session-lifecycle.js';

it('runs canonical storage and metadata changes without host management or business adapters', async () => {
  const f = await createEngineFixture('core-without-host-SYNTHETIC', { enableCodexMirror: false, hostIntegrations: false, extensionAdapters: [], sessionLifecycleAdapters: [] });
  try {
    expect(f.engine.integrations).toBeUndefined();
    const id = 'independent-session' as LogicalSessionId;
    await reconcileEndpointSession(f.engine.canonicalEngine.store, { logicalSessionId: id, baseVersionId: null, events: [],
      title: 'independent', tags: [], archivedAt: null, workspaceId: null, observedAt: new Date().toISOString() });
    await f.engine.sessionCommands.updateSession(id, { archived: true });
    expect((await f.engine.canonicalEngine.store.getSession(id))?.session.archivedAt).not.toBeNull();
    expect(f.engine.repository.database.prepare('SELECT count(*) AS n FROM extension_objects').get()?.n).toBe(0);
  } finally { await f.cleanupAll(); }
});

it('rolls back canonical metadata when a registered lifecycle participant fails', async () => {
  const f = await createEngineFixture('lifecycle-rollback-SYNTHETIC', { enableCodexMirror: false, hostIntegrations: false, extensionAdapters: [],
    sessionLifecycleAdapters: [{ id: 'synthetic-business', sessionChanged: state => { if (state.archivedAt) throw new Error('participant failed'); } }] });
  try {
    const id = 'rollback-session' as LogicalSessionId;
    await reconcileEndpointSession(f.engine.canonicalEngine.store, { logicalSessionId: id, baseVersionId: null, events: [],
      title: 'rollback', tags: [], archivedAt: null, workspaceId: null, observedAt: new Date().toISOString() });
    await expect(f.engine.sessionCommands.updateSession(id, { archived: true })).rejects.toThrow('participant failed');
    expect((await f.engine.canonicalEngine.store.getSession(id))?.session.archivedAt).toBeNull();
    expect(() => new SessionLifecycle([{ id: 'duplicate', sessionChanged() {} }, { id: 'duplicate', sessionChanged() {} }])).toThrow('Duplicate');
  } finally { await f.cleanupAll(); }
});

it('bundles unknown structures without changing their identity, sequence, sources or nested payload', () => {
  const events = [0, 1].map(sequence => ({ schemaVersion: 1, id: `unknown-${sequence}`, logicalSessionId: 'logical', sequence,
    kind: 'opaque-unknown', role: 'unknown', content: { nested: [null, { special: '完整\n原文' }] }, contentDigest: 'retained-digest',
    rawPayload: { unrecognized: { seq: sequence, references: ['external-id'] } }, extensions: { originalFormat: 'future' },
    source: { platform: 'dsh', instanceId: 'fixture', sessionId: 'native', eventId: `${sequence}`, cursor: `${sequence}` } } as CanonicalEventV1));
  const before = JSON.stringify(events), bundle = packOpaqueEvents(events);
  expect(JSON.parse(JSON.stringify(bundle)).events).toEqual(events);
  expect(JSON.stringify(events)).toBe(before);
  expect(() => packOpaqueEvents([events[0]!, { ...events[1]!, logicalSessionId: 'other' as LogicalSessionId }])).toThrow('one logical session');
});

it('retains unknown structures durably and maps their reader entries to one bundle', async () => {
  const f = await createEngineFixture('opaque-storage-SYNTHETIC', { enableCodexMirror: false, hostIntegrations: false, extensionAdapters: [] });
  try {
    const id = 'opaque-session' as LogicalSessionId;
    const events = [0, 1].map(sequence => ({ schemaVersion: 1, id: `unknown-${sequence}`, logicalSessionId: id, sequence,
      kind: 'opaque-unknown', role: 'unknown', content: { nested: { values: [null, false, 'retained'] } }, contentDigest: 'sha256:retained',
      rawPayload: { unsupportedType: 'future/plugin', reference: `original-${sequence}` }, extensions: { format: 'future' },
      source: { platform: 'dsh', instanceId: 'fixture', sessionId: 'native', eventId: `${sequence}`, cursor: `${sequence}` } } as CanonicalEventV1));
    const receipt = await reconcileEndpointSession(f.engine.canonicalEngine.store, { logicalSessionId: id, baseVersionId: null, events,
      title: 'opaque', tags: [], archivedAt: null, workspaceId: null, observedAt: new Date().toISOString() });
    expect((await f.engine.canonicalEngine.store.getVersion(receipt.versionId!))?.events).toEqual(events);
    const reader = f.engine.sessionQueries.readonlyReader(), page = reader.page(id, {});
    const process = reader.process(id, { snapshot: page.snapshot, turnId: page.turns[0]!.id });
    expect(process.items).toEqual([{ id: 'opaque-unknown-0', kind: 'opaque-data', label: '未识别数据包', eventIds: ['unknown-0', 'unknown-1'], paired: false }]);
    expect(JSON.stringify(process)).not.toContain('unsupportedType');
  } finally { await f.cleanupAll(); }
});
