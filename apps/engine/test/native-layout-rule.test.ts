import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { JsonValue } from '@linmu/dsh-session-contracts';
import { inspectV3NativeSpace, v3NativeProjectKey } from '@linmu/dsh-session-adapter-0-1-5';
import { applyNativeOverwrite, nativeProjectDirectory, planNativeOverwrite, type NativeOverwriteJournalEntry,
  type NativeOverwriteSession, type NativeOverwriteState } from '../src/native-session-overwrite.js';

/**
 * The native layout has exactly one rule, and the Engine no longer keeps a second copy of it.
 *
 * The defect this pins: the project key was applied twice — the caller appended it to the root and
 * the adapter's layout rule appended it again — so every read failed with "Misplaced native
 * artifact" and a write would have landed one directory too deep.
 */
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-layout-'));
  roots.push(root);
  const sessionsRoot = join(root, 'home', 'sessions');
  await mkdir(sessionsRoot, { recursive: true });
  return { root, sessionsRoot, backupRoot: join(root, 'backups'), engineStateRoot: join(root, 'engine-state') };
}

const CWD = 'D:\\合成\\工作区';
/** The extended-length spelling DSH records for a canonical project; it must key like any other path. */
const LONG_CWD = '\\\\?\\C:\\Users\\19717\\OneDrive\\文档\\计算机四大';
const session = (nativeId: string): NativeOverwriteSession => ({ nativeSessionId: nativeId, revision: 'head-1', archived: false,
  payload: { header: { version: 3, id: nativeId, cwd: CWD, createdAt: 1, isSeeded: false, agentPreset: 'standard', delegationDepth: 0 },
    inheritedEventCount: 0,
    events: [{ seq: 0, time: 1, type: 'user/message', surfaceOp: 'append', data: { id: `${nativeId}-event`, role: 'user',
      content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } } as unknown as JsonValue] } });
const emptyState = (): NativeOverwriteState => ({ revisions: new Map(), archived: new Map() });
const journal: NativeOverwriteJournalEntry[] = [];

it('derives the project key with the adapter rule, for every spelling the platform records', () => {
  for (const cwd of [CWD, LONG_CWD, '/home/user/project', 'C:\\', 'Ünïcode\\目录', '~/relative']) {
    expect(nativeProjectDirectory(cwd)).toBe(v3NativeProjectKey(cwd));
  }
  // An absent cwd keeps its own spelling; the adapter rule refuses the empty string by design.
  expect(nativeProjectDirectory(undefined)).toBe('_no-cwd');
  expect(nativeProjectDirectory('')).toBe('_no-cwd');
  expect(v3NativeProjectKey('D:\\DeepSeekDemoWorkplace')).toBe('--D-DeepSeekDemoWorkplace--');
});

it('writes where the layout says, and the sessions root reads it back', async () => {
  const f = await scratch();
  const one = session('session-11111111-2222-3333-4444-555555555555');
  const plan = planNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [one], state: emptyState() });
  // The write lands under the project key the layout rule derives, one level under the sessions root.
  expect(plan.entries[0]!.relativePath).toBe(`${v3NativeProjectKey(CWD)}/${one.nativeSessionId}/session.v3.jsonl.zstd`);
  await applyNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [one], plan,
    journal: async entry => { journal.push(entry); }, backupRoot: f.backupRoot, stateRoot: f.engineStateRoot, instanceId: 'i-synthetic' });
  journal.splice(0);
  // Reading the sessions root accepts it: one rule, both directions.
  const artifacts = await inspectV3NativeSpace(f.sessionsRoot);
  expect(artifacts.map(artifact => artifact.nativeSessionId)).toEqual([one.nativeSessionId]);
  expect(artifacts[0]!.relativePath.replaceAll('\\', '/')).toBe(plan.entries[0]!.relativePath);
});

it('still refuses a project directory used as the native root', async () => {
  const f = await scratch();
  const one = session('session-66666666-7777-8888-9999-000000000000');
  const plan = planNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [one], state: emptyState() });
  await applyNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [one], plan,
    journal: async entry => { journal.push(entry); }, backupRoot: f.backupRoot, stateRoot: f.engineStateRoot, instanceId: 'i-synthetic' });
  journal.splice(0);
  // Handing the project directory in as the root is exactly the defect: appending the key again
  // makes every artifact look misplaced, and that protection is retained on purpose.
  await expect(inspectV3NativeSpace(join(f.sessionsRoot, v3NativeProjectKey(CWD))))
    .rejects.toThrow(/Misplaced native artifact/u);
});
