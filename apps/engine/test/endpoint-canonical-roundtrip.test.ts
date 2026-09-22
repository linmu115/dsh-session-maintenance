import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { openMaintenanceDatabase, SqliteCanonicalRepository, SqliteCanonicalSessionEngineStore, ZstdContentObjectStore } from '@linmu/dsh-session-store';
import { reconcileEndpointSession } from '@linmu/dsh-canonical-session-engine';
import { v3NativeProjectKey, v3NativeSessionCodec } from '@linmu/dsh-session-adapter-0-1-5';
import { readEndpointSnapshot } from '@linmu/dsh-instance-integration-dsh/endpoint-snapshot';
import { createInstanceWorkspaceSource } from '@linmu/dsh-instance-integration-dsh/instance-workspace-source';
import { mapWorkspaceFolders } from '@linmu/dsh-instance-integration-dsh/instance-write-back';
import type { CanonicalProjectionInput, LogicalSessionId, LogicalWorkspaceId } from '@linmu/dsh-session-contracts';

it('imports native content, appends, renames, archives and moves through canonical snapshots without losing prior history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-roundtrip-fixture-'));
  const db = openMaintenanceDatabase(join(root, 'metadata.sqlite'));
  try {
    await writeFile(join(root, '.synthetic-fixture'), 'No real homes');
    const repository = new SqliteCanonicalRepository(db), store = new SqliteCanonicalSessionEngineStore(db, new ZstdContentObjectStore(root));
    const at = '2026-09-22T00:00:00.000Z', sessionId = 'native-fixture', logicalSessionId = 'logical-fixture' as LogicalSessionId;
    const a = 'workspace-a' as LogicalWorkspaceId, b = 'workspace-b' as LogicalWorkspaceId;
    const workspaces = [a, b].map(id => ({ schemaVersion: 1 as const, id, name: id, parentId: null, sortKey: id, deletedAt: null, createdAt: at, updatedAt: at }));
    for (const workspace of workspaces) await repository.upsertLogicalWorkspace(workspace);
    const home = join(root, 'home'), cwd = join(root, 'work-a'), other = join(root, 'work-b');
    await mkdir(join(home, 'storages'), { recursive: true });
    const state = (archived: boolean) => writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { archivedSessionIds: archived ? [sessionId] : [] } }));
    await state(false);
    const events: unknown[] = [{ seq: 0, time: Date.parse(at), type: 'user/message', surfaceOp: 'append', data: { id: 'message-0', role: 'user', content: [{ type: 'text', text: 'initial' }], source: { kind: 'user' } } }];
    let oldFile: string | undefined;
    async function persist(directory: string) {
      const header = { version: 3, id: sessionId, cwd: directory, createdAt: Date.parse(at), delegationDepth: 0, isSeeded: false };
      const file = join(home, 'sessions', v3NativeProjectKey(directory), sessionId, 'session.v3.jsonl.zstd');
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, v3NativeSessionCodec.encode({ header, events, inheritedEventCount: 0 } as never, { header, relativePath: file }));
      if (oldFile && oldFile !== file) { await rm(oldFile); await rm(dirname(oldFile), { recursive: true }); }
      oldFile = file;
    }
    await persist(cwd);
    let projection = { run: { id: 'fixture' }, workspaces, sessions: [] } as unknown as CanonicalProjectionInput;
    const read = () => readEndpointSnapshot({ homeRoot: home, stateRoot: root, workspaceRoot: root, endpointId: 'endpoint', nativeSessionId: sessionId,
      logicalSessionId, projection, folders: [{ workspaceId: a, path: cwd }, { workspaceId: b, path: other }] });
    const first = await read(); const created = await reconcileEndpointSession(store, first); expect(created.outcome).toBe('created');
    const current = (await store.getSession(logicalSessionId))!;
    const head = (await store.getVersion(current.headVersionId!))!;
    projection = { ...projection, sessions: [{ session: current.session, events: head.events, workspaceId: a, projectRoot: cwd, projectId: null, projectName: null }] };
    events.push({ seq: 1, time: Date.parse(at), type: 'session/title', data: { title: 'renamed', messageSeqs: [], source: { kind: 'user' } } });
    await persist(other); await state(true);
    const next = await read(); expect(next.events.slice(0, head.events.length)).toEqual(head.events);
    const changed = await reconcileEndpointSession(store, next); expect(changed.outcome).toBe('advanced');
    const after = (await store.getSession(logicalSessionId))!;
    expect(after.workspaceId).toBe(b); expect(after.session.title).toBe('renamed'); expect(after.session.archivedAt).not.toBeNull();
    expect((await store.getVersion(after.headVersionId!))!.events).toHaveLength(2);
    expect((await store.getVersion(head.id))!.events).toHaveLength(1);
    await expect(reconcileEndpointSession(store, next)).rejects.toMatchObject({ code: 'SYNC_STALE_HEAD' });
    const matching = { ...next, baseVersionId: after.headVersionId };
    expect((await reconcileEndpointSession(store, matching)).outcome).toBe('noop');
    await expect(reconcileEndpointSession(store, { ...matching, events: [] })).rejects.toMatchObject({ code: 'SYNC_PREFIX_CHANGED' });
    // Joining a different project cannot read this session or be broken by its contents.
    const source = createInstanceWorkspaceSource({ sessionsRoot: join(home, 'sessions'), projectDirectory: v3NativeProjectKey(cwd), instanceId: 'endpoint', logicalSessionId: () => logicalSessionId });
    expect(await source.list()).toEqual([]);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

it('does not reuse unrelated same-name workspaces and assigns collisions independently of row order', () => {
  const buckets = [{ workspaceId: 'a', name: 'same' }, { workspaceId: 'b', name: 'same' }];
  const input = { workspaceRoot: 'D:/fixture', registered: new Map([['same', 'D:/unbound']]), buckets };
  const mapped = mapWorkspaceFolders(input);
  expect(mapped[0]!.path).not.toBe('D:/unbound');
  expect(mapWorkspaceFolders({ ...input, buckets: [...buckets].reverse() })).toEqual(mapped);
});
