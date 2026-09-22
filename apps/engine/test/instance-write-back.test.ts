import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { CanonicalProjectionInput, JsonValue, LogicalWorkspaceId } from '@linmu/dsh-session-contracts';
import { v3NativeProjectKey } from '@linmu/dsh-session-adapter-0-1-5';
import { createAdapterMaterializer, writeBackInstanceWorkspaces, workspaceFolderName } from '../src/instance-write-back.js';

/**
 * True-source → instance, scoped to what the operator selected and mapped onto the instance's own
 * local workspaces.
 *
 * The defects these pin: saving a range only recorded intent, so nothing ever reached the instance;
 * an unselected (instance-native) bucket must stay untouched; and a mapped bucket must land in a
 * *real* folder under the workspace root with the session's `cwd` pointing at it, because the host
 * resolves a session's `cwd` and requires it to equal the registered workspace path.
 */
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-write-back-'));
  roots.push(root);
  const sessionsRoot = join(root, 'home', 'sessions');
  const workspaceRoot = join(root, 'DSHworkplace');
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  return { root, sessionsRoot, workspaceRoot };
}

const CWD = 'C:\\工作区四';
const INSTANCE = 'i-one';
const AT = '2026-09-21T10:00:00.000Z';
const BUCKET_NAME = '计算机四大';
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

function options(workspaceId: LogicalWorkspaceId, selected: readonly string[], f: { root: string; workspaceRoot: string }) {
  return {
    stateRoot: join(f.root, 'engine-state'), backupRoot: join(f.root, 'backups'), journalPath: join(f.root, 'logs', 'write-back.jsonl'),
    workspaceRoot: f.workspaceRoot,
    selectionFor: () => ({ revision: 1, selection: { kind: 'ids' as const, workspaceIds: selected, includeUnassigned: false } }),
    memberships: async () => new Map<string, LogicalWorkspaceId | null>([['logical-one', workspaceId]]),
    workspaceNames: async () => new Map([[String(workspaceId), BUCKET_NAME]]),
    loadProjection: async () => projection(workspaceId),
  };
}
const request = (sessionsRoot: string) => ({ instanceId: INSTANCE, profileId: 'web-i27c4', sessionsRoot });

it('writes a selected bucket into its own local folder, with the session pointing at that folder', async () => {
  const f = await scratch();
  const workspaceId = 'workspace-selected' as LogicalWorkspaceId;
  const summary = await writeBackInstanceWorkspaces(options(workspaceId, [workspaceId], f), request(f.sessionsRoot));
  // The bucket's own name becomes the folder, so an operator can read the instance's tree.
  expect(await readdir(f.workspaceRoot)).toEqual([BUCKET_NAME]);
  // Sessions are filed under the local folder they were mapped to, not under the source machine's path.
  const folder = join(f.workspaceRoot, BUCKET_NAME);
  expect(await readdir(f.sessionsRoot)).toEqual([v3NativeProjectKey(folder)]);
  const [project] = await readdir(f.sessionsRoot);
  const [sessionDirectory] = await readdir(join(f.sessionsRoot, project!));
  expect(sessionDirectory).toMatch(/^dsh-maintenance_/u);
  expect(summary.written).toBe(1);
  expect(summary.skippedOutOfScope).toBe(0);
  expect(summary.workspaceFolders).toEqual([folder]);
});

it('leaves an unselected bucket completely alone and creates no folder for it', async () => {
  const f = await scratch();
  const summary = await writeBackInstanceWorkspaces(
    options('workspace-native' as LogicalWorkspaceId, ['workspace-other'], f), request(f.sessionsRoot));
  expect(summary.written).toBe(0);
  expect(summary.skippedOutOfScope).toBe(1);
  expect(await readdir(f.sessionsRoot)).toEqual([]);
  expect(await readdir(f.workspaceRoot)).toEqual([]);
});

it('reuses an existing local folder instead of recreating it', async () => {
  const f = await scratch();
  const workspaceId = 'workspace-selected' as LogicalWorkspaceId;
  await mkdir(join(f.workspaceRoot, BUCKET_NAME), { recursive: true });
  const summary = await writeBackInstanceWorkspaces(options(workspaceId, [workspaceId], f), request(f.sessionsRoot));
  expect(await readdir(f.workspaceRoot)).toEqual([BUCKET_NAME]);
  expect(summary.written).toBe(1);
});

it('keeps an unsafe bucket name inside the folder it names', () => {
  expect(workspaceFolderName('a/b:c*d?', 'workspace-x')).toBe('a_b_c_d_');
  expect(workspaceFolderName('   ', 'workspace-x')).toBe('workspace-x');
  expect(workspaceFolderName('..', 'workspace-x')).toBe('workspace-x');
});

it('materialises through the adapter with the mapped folder as the session cwd', async () => {
  const folder = join('D:', 'DSHworkplace', BUCKET_NAME);
  const materialized = await createAdapterMaterializer([], new Map([['workspace-selected', folder]]))(projection('workspace-selected' as LogicalWorkspaceId));
  expect(materialized).toHaveLength(1);
  expect(materialized[0]!.nativeSessionId).toMatch(/^dsh-maintenance_/u);
  const header = (materialized[0]!.payload as unknown as { header: { cwd?: string } }).header;
  // Without a mapping the source path would be used; with one, the instance's own folder wins.
  expect(header.cwd).toBe(folder);
});
