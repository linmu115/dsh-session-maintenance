import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { CanonicalProjectionInput, JsonValue, LogicalWorkspaceId } from '@linmu/dsh-session-contracts';
import { v3NativeProjectKey } from '@linmu/dsh-session-adapter-0-1-5';
import { createAdapterMaterializer, writeBackInstanceWorkspaces } from '../src/instance-write-back.js';

/**
 * True-source → instance, scoped to what the operator selected.
 *
 * The defect these pin: saving a range only recorded intent, so nothing ever reached the instance;
 * and once a write-back exists, an unselected (instance-native) workspace must remain untouched.
 */
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-write-back-'));
  roots.push(root);
  const sessionsRoot = join(root, 'home', 'sessions');
  await mkdir(sessionsRoot, { recursive: true });
  return { root, sessionsRoot };
}

const CWD = 'C:\\工作区四';
const INSTANCE = 'i-one';
const AT = '2026-09-21T10:00:00.000Z';
/** One canonical session in the shape the projection source hands the adapter (see the writeback suite). */
function projection(workspaceId: LogicalWorkspaceId): CanonicalProjectionInput {
  const id = 'logical-one';
  return { run: { id: 'run' }, workspaces: [], sessions: [{
    session: { schemaVersion: 1, id, headVersionId: `version-${id}`, title: '会话', tags: [], archivedAt: null,
      createdAt: AT, updatedAt: AT, deletedAt: null },
    events: [{ schemaVersion: 1, id: `event-${id}`, logicalSessionId: id, sequence: 0, kind: 'user-message', role: 'user',
      content: { text: 'hello' }, contentDigest: `sha256:${id}`,
      rawPayload: { seq: 0, time: Date.parse(AT), type: 'user/message', surfaceOp: 'append',
        data: { id: `event-${id}`, role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } } as unknown as JsonValue,
      extensions: { nativeFormatVersion: 3 },
      source: { platform: 'dsh', instanceId: INSTANCE, sessionId: `dsh-maintenance_${id}`, eventId: '0', cursor: '0' } }],
    workspaceId, projectId: null, projectName: null, projectRoot: CWD,
  }] } as unknown as CanonicalProjectionInput;
}

function options(sessionsRoot: string, workspaceId: LogicalWorkspaceId, selected: readonly string[], root: string) {
  return {
    stateRoot: join(root, 'engine-state'), backupRoot: join(root, 'backups'), journalPath: join(root, 'logs', 'write-back.jsonl'),
    selectionFor: () => ({ revision: 1, selection: { kind: 'ids' as const, workspaceIds: selected, includeUnassigned: false } }),
    memberships: async () => new Map<string, LogicalWorkspaceId | null>([['logical-one', workspaceId]]),
    loadProjection: async () => projection(workspaceId),
  };
}
const request = (sessionsRoot: string) => ({ instanceId: 'i-one', profileId: 'web-i27c4', sessionsRoot });

it('writes a selected workspace into the instance under the project key the adapter derives', async () => {
  const f = await scratch();
  const workspaceId = 'workspace-selected' as LogicalWorkspaceId;
  const summary = await writeBackInstanceWorkspaces(options(f.sessionsRoot, workspaceId, [workspaceId], f.root), request(f.sessionsRoot));
  // The project key is the adapter's own encoding of the session's cwd, character for character.
  expect(await readdir(f.sessionsRoot)).toEqual([v3NativeProjectKey(CWD)]);
  const projects = await readdir(f.sessionsRoot);
  const [sessionDirectory] = await readdir(join(f.sessionsRoot, projects[0]!));
  // The adapter names the native session from its logical parent; that naming is its business.
  expect(sessionDirectory).toMatch(/^dsh-maintenance_/u);
  expect(summary.written).toBe(1);
  expect(summary.skippedOutOfScope).toBe(0);
});

it('leaves an unselected workspace completely alone', async () => {
  const f = await scratch();
  const summary = await writeBackInstanceWorkspaces(
    options(f.sessionsRoot, 'workspace-native' as LogicalWorkspaceId, ['workspace-other'], f.root), request(f.sessionsRoot));
  expect(summary.written).toBe(0);
  expect(summary.skippedOutOfScope).toBe(1);
  expect(await readdir(f.sessionsRoot)).toEqual([]);
});

it('materialises through the adapter, so the payload keeps the session’s own cwd', async () => {
  const materialized = await createAdapterMaterializer()(projection('workspace-selected' as LogicalWorkspaceId));
  expect(materialized).toHaveLength(1);
  expect(materialized[0]!.nativeSessionId).toMatch(/^dsh-maintenance_/u);
  const header = (materialized[0]!.payload as unknown as { header: { cwd?: string } }).header;
  expect(header.cwd).toBe(CWD);
});
