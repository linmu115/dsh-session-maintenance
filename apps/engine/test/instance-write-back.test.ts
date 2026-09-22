import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { CanonicalProjectionInput, JsonValue, LogicalWorkspaceId } from '@linmu/dsh-session-contracts';
import { v3NativeProjectKey } from '@linmu/dsh-session-adapter-0-1-5';
import { createAdapterMaterializer, writeBackInstanceWorkspaces, workspaceFolderName } from '../src/instance-write-back.js';
import { writeBackProjectionToInstance } from '../src/instance-session-writeback.js';

/**
 * True-source → instance, scoped to what the operator selected and mapped onto the instance's own
 * local workspaces.
 *
 * The defects these pin: saving a range only recorded intent, so nothing ever reached the instance;
 * an unselected (instance-native) bucket must stay untouched; a mapped bucket must land in a
 * *real* folder under the workspace root with the session's `cwd` pointing at it, because the host
 * resolves a session's `cwd` and requires it to equal the registered workspace path; and a session
 * that moves between those folders must never be left behind, because one id under two project
 * directories makes the host refuse to start at all.
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
const request = (sessionsRoot: string) => ({ instanceId: INSTANCE, profileId: 'web-i27c4', sessionsRoot,
  instanceHome: join(sessionsRoot, '..') });

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

/** The one session directory a write-back would produce, relative to the sessions root. */
async function soleSession(sessionsRoot: string, project: string): Promise<string> {
  const [directory] = await readdir(join(sessionsRoot, project));
  return join(sessionsRoot, project, directory!, 'session.v3.jsonl.zstd');
}

it('moves a session out of the project directory its old cwd named instead of duplicating it', async () => {
  const f = await scratch();
  const workspaceId = 'workspace-selected' as LogicalWorkspaceId;
  // First the instance holds the session under the source machine's own path, which is what the
  // join direction wrote before any workspace mapping existed.
  await writeBackProjectionToInstance({ projection: projection(workspaceId), sessionsRoot: f.sessionsRoot,
    stateRoot: join(f.root, 'engine-state'), instanceId: INSTANCE, backupRoot: join(f.root, 'backups'),
    inScope: () => true, archived: () => false, journal: async () => undefined });
  const sourceProject = v3NativeProjectKey(CWD);
  expect(await readdir(f.sessionsRoot)).toEqual([sourceProject]);
  const oldFile = await soleSession(f.sessionsRoot, sourceProject);

  // Then the bucket is mapped to a folder under the workspace root. The instance must end up with
  // one copy — the host refuses to start when one id sits under two project directories.
  const summary = await writeBackInstanceWorkspaces(options(workspaceId, [workspaceId], f), request(f.sessionsRoot));
  const mappedProject = v3NativeProjectKey(join(f.workspaceRoot, BUCKET_NAME));
  expect(await readdir(f.sessionsRoot)).toEqual([mappedProject]);
  expect(summary.written).toBe(1);
  const moved = await soleSession(f.sessionsRoot, mappedProject);
  expect((await stat(moved)).size).toBeGreaterThan(0);
  expect(await readFile(oldFile).catch(() => undefined)).toBeUndefined();
  // The retired copy is kept, so the move is as reversible as a write.
  const journal = await readFile(join(f.root, 'logs', 'write-back.jsonl'), 'utf8');
  expect(journal).toContain(sourceProject);
  expect(journal).toContain('"relocatedFrom"');
});

it('rewrites content the instance lost to an empty placeholder', async () => {
  const f = await scratch();
  const workspaceId = 'workspace-selected' as LogicalWorkspaceId;
  await writeBackInstanceWorkspaces(options(workspaceId, [workspaceId], f), request(f.sessionsRoot));
  const mappedProject = v3NativeProjectKey(join(f.workspaceRoot, BUCKET_NAME));
  const file = await soleSession(f.sessionsRoot, mappedProject);
  // A hand recovery that empties the file leaves the Engine's own record intact; the host skips a
  // file with no header, so the content has to be written again rather than trusted.
  await writeFile(file, Buffer.alloc(0));
  const summary = await writeBackInstanceWorkspaces(options(workspaceId, [workspaceId], f), request(f.sessionsRoot));
  expect(summary.written).toBe(1);
  expect((await stat(file)).size).toBeGreaterThan(0);
});

it('reuses a workspace the instance already owns instead of mapping a second folder for it', async () => {
  const f = await scratch();
  const workspaceId = 'workspace-selected' as LogicalWorkspaceId;
  // The operator's rule: a workspace that already exists is reused, never recreated. The instance's
  // registry is the record of what it owns.
  const owned = join(f.root, 'owned');
  await mkdir(owned, { recursive: true });
  await mkdir(join(f.root, 'home', 'storages'), { recursive: true });
  await writeFile(join(f.root, 'home', 'storages', 'workspace.json'), `${JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [] },
    tables: { workspaces: { 'ws-1': { path: owned, title: BUCKET_NAME, sessionIds: [] } } },
  }, null, 2)}\n`, 'utf8');
  const summary = await writeBackInstanceWorkspaces(options(workspaceId, [workspaceId], f), request(f.sessionsRoot));
  expect(summary.workspaceFolders).toEqual([owned]);
  expect(await readdir(f.workspaceRoot)).toEqual([]);
  expect(await readdir(f.sessionsRoot)).toEqual([v3NativeProjectKey(owned)]);
});

it('falls back to the mapped folder when the instance registry cannot be interpreted', async () => {
  const f = await scratch();
  const workspaceId = 'workspace-selected' as LogicalWorkspaceId;
  await mkdir(join(f.root, 'home', 'storages'), { recursive: true });
  await writeFile(join(f.root, 'home', 'storages', 'workspace.json'), '{ not json', 'utf8');
  const summary = await writeBackInstanceWorkspaces(options(workspaceId, [workspaceId], f), request(f.sessionsRoot));
  // A store this reader does not understand is not a reason to fail a sync: the mapped folder is
  // the documented default.
  expect(summary.workspaceFolders).toEqual([join(f.workspaceRoot, BUCKET_NAME)]);
  expect(summary.written).toBe(1);
});
