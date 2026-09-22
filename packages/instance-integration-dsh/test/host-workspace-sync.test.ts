import { expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { synchronizeThroughHost, resolveHostProfileRoot } from '../src/host-workspace-sync.js';
import { v3NativeSessionId } from '@linmu/dsh-session-adapter-0-1-5';
import type { CanonicalProjectionInput, LogicalSessionId } from '@linmu/dsh-session-contracts';
vi.mock('../src/instance-lease.js', () => ({ inspectInstanceLease: async () => ({ state: 'running',
  runtimeUrl: 'http://127.0.0.1:12345', process: { pid: 123, startedAt: 'synthetic-process' } }) }));

it('resolves physical profiles by the complete declared identity and rejects duplicate declarations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-profile-SYNTHETIC-'));
  try {
    expect(await resolveHostProfileRoot(root, 'instance', 'logical-profile')).toBeNull();
    const patch = (instance: string, profile: string) => JSON.stringify([{ id: 'session-maintenance', config: { dshInstanceId: instance, profileId: profile } }]);
    for (const name of ['web', 'logical-profile']) await mkdir(join(root, 'profiles', name), { recursive: true });
    await writeFile(join(root, 'profiles', 'web', 'cordis.patch.yml'), patch('instance', 'logical-profile'));
    await writeFile(join(root, 'profiles', 'logical-profile', 'cordis.patch.yml'), patch('foreign', 'logical-profile'));
    expect(await resolveHostProfileRoot(root, 'instance', 'logical-profile')).toBe(join(root, 'profiles', 'web'));
    expect(await resolveHostProfileRoot(root, 'instance', 'absent')).toBeNull();
    await writeFile(join(root, 'profiles', 'logical-profile', 'cordis.patch.yml'), patch('instance', 'logical-profile'));
    await expect(resolveHostProfileRoot(root, 'instance', 'logical-profile')).rejects.toMatchObject({ code: 'SYNC_HOST_PROFILE_AMBIGUOUS' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('validates the complete host receipt before recording identities, and rejects stale, malformed or partial acknowledgements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-sync-client-SYNTHETIC-'));
  try {
    await writeFile(join(root, 'connection.json'), JSON.stringify({ schemaVersion: 1, token: 'synthetic-token-'.repeat(4) }));
    const at = '2026-09-22T01:00:00.000Z';
    const projection = { run: { id: 'synthetic', instanceId: 'instance', profileId: 'profile' }, workspaces: [],
      sessions: ['one', 'two'].map(id => ({ workspaceId: null, events: [], session: { schemaVersion: 1, id,
        authorityScope: 'maintenance', originKind: 'maintenance-native', headVersionId: null, title: id, tags: [],
        archivedAt: null, tombstonedAt: null, createdAt: at, updatedAt: at } })) } as unknown as CanonicalProjectionInput;
    let inStore = false;
    const bindIdentity = vi.fn(async () => { expect(inStore).toBe(true); });
    const options = { withStoreAccess: async <T>(work: () => Promise<T>) => { expect(inStore).toBe(false); inStore = true; try { return await work(); } finally { inStore = false; } }, stateRoot: root, backupRoot: root, journalPath: join(root, 'journal'), workspaceRoot: root,
      selectionFor: () => ({ schemaVersion: 1, instanceId: 'instance', updatedAt: at, revision: 1, selection: { kind: 'all' as const } }), memberships: async () => new Map(),
      workspaceNames: async () => new Map(), loadProjection: async () => projection, bindIdentity };
    const request = { instanceId: 'instance', profileId: 'profile', instanceHome: root, sessionsRoot: join(root, 'sessions') };
    const bindings = ['one', 'two'].map(id => ({ nativeSessionId: String(v3NativeSessionId(id as LogicalSessionId)), logicalSessionId: id }));
    const run = (alter: (receipt: any) => void, status = 200) => synchronizeThroughHost(options, request, (async (_url, init) => {
      expect(inStore).toBe(false); // A slow host must never retain the canonical writer.
      const compressed = new Headers(init!.headers).get('content-encoding') === 'gzip';
      const body = JSON.parse(compressed ? gunzipSync(init!.body as Uint8Array).toString('utf8') : String(init!.body));
      expect(compressed).toBe(projection.sessions[0]!.session.tags.length > 0);
      expect(body.projection.sessions).toEqual(projection.sessions);
      expect(body.selection).toEqual({ revision: 1, selection: { kind: 'all' } });
      const receipt = { schemaVersion: 1, operationId: body.operationId, instanceId: body.instanceId, profileId: body.profileId,
        pid: body.pid, processStartedAt: body.processStartedAt, summary: { written: 2, unchanged: 0, skippedOutOfScope: 0, failures: [] },
        bindings: structuredClone(bindings) };
      alter(receipt); return new Response(JSON.stringify(receipt), { status });
    }) as typeof fetch);
    for (const alter of [
      (r: any) => { r.pid++; }, (r: any) => { r.summary.written = -1; },
      (r: any) => { r.bindings[1].logicalSessionId = 'foreign'; },
      (r: any) => { r.bindings[1] = r.bindings[0]; },
      (r: any) => { r.bindings.pop(); r.summary.written = 1; },
    ]) {
      bindIdentity.mockClear(); await expect(run(alter)).rejects.toMatchObject({ status: 409 });
      expect(bindIdentity.mock.calls.every(call => (call as unknown[])[2] === true)).toBe(true);
    }
    await expect(run(() => {}, 409)).rejects.toMatchObject({ code: 'SYNC_HOST_REJECTED', status: 409 });
    bindIdentity.mockClear(); await expect(run(() => { (projection.sessions[0]!.session as any).title = 'changed while waiting'; })).rejects.toMatchObject({ code: 'SYNC_SOURCE_CHANGED' });
    expect(bindIdentity.mock.calls.every(call => (call as unknown[])[2] === true)).toBe(true);
    bindIdentity.mockClear(); await expect(run(() => {})).resolves.toMatchObject({ written: 2 });
    expect(bindIdentity.mock.calls.filter(call => (call as unknown[])[2] === false)).toHaveLength(2);
    (projection.sessions[0]!.session as any).tags = Array.from({ length: 10000 }, () => 'large-payload-'.repeat(12));
    await expect(run(() => {})).resolves.toMatchObject({ written: 2 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
