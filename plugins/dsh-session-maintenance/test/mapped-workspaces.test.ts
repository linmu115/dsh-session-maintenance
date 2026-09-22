import { expect, it, vi } from 'vitest';
import { MappedWorkspaceRegistration, type MappedFolder } from '../src/mapped-workspaces.js';

/**
 * The instance's half of "true source → instance".
 *
 * The defect this pins: the Engine wrote a bucket's sessions into its mapped folder and nothing
 * appeared, because the instance only ever registered workspaces while a prepared *run* attached —
 * and an accepted instance is normally started without one. Registration therefore has to happen on
 * a plain boot, and it has to be idempotent, because it happens on every boot.
 */
function host() {
  const created: { path: string; title: string }[] = [];
  const attached: string[] = [];
  const failFor = new Set<string>();
  return {
    created, attached, failFor,
    workspaceRegistry: {
      create: async (path: string, title?: string) => {
        created.push({ path, title: title ?? '' });
        return {
          id: path, path, title: title ?? '',
          attachSession: async (sessionId: string) => {
            if (failFor.has(sessionId)) throw new Error(`session '${sessionId}' is not accounted for`);
            attached.push(sessionId);
          },
        };
      },
    },
  };
}

const folders: readonly MappedFolder[] = [
  { name: '计算机四大', path: 'D:\\DSHworkplace\\计算机四大', sessions: ['dsh-maintenance_one', 'dsh-maintenance_two'] },
  { name: 'DeepSeekDemoWorkplace', path: 'D:\\DeepSeekDemoWorkplace', sessions: ['session-three'] },
];

it('registers every mapped folder and gives it its sessions', async () => {
  const registry = host();
  const registration = new MappedWorkspaceRegistration({ host: registry, listFolders: async () => folders });
  const result = await registration.pass();
  expect(result.registered).toEqual(['D:\\DSHworkplace\\计算机四大', 'D:\\DeepSeekDemoWorkplace']);
  expect(result.attached).toBe(3);
  expect(result.failures).toEqual([]);
  expect(registry.created.map(entry => entry.title)).toEqual(['计算机四大', 'DeepSeekDemoWorkplace']);
  expect(registry.attached).toEqual(['dsh-maintenance_one', 'dsh-maintenance_two', 'session-three']);
});

it('does not create a second workspace or re-attach on the next boot', async () => {
  const registry = host();
  const registration = new MappedWorkspaceRegistration({ host: registry, listFolders: async () => folders });
  await registration.pass();
  const again = await registration.pass();
  // `create` is idempotent at the host, but a repeated attach is a mutation of the operator's own
  // membership order, so it is skipped rather than replayed.
  expect(again.registered).toEqual([]);
  expect(again.attached).toBe(0);
  expect(registry.attached).toHaveLength(3);
});

it('retries a session the host cannot place yet without losing the folder', async () => {
  const registry = host();
  registry.failFor.add('dsh-maintenance_two');
  const registration = new MappedWorkspaceRegistration({ host: registry, listFolders: async () => folders });
  const first = await registration.pass();
  expect(first.failures).toHaveLength(1);
  // The unplaceable session does not hold back the folders after it.
  expect(registry.attached).toEqual(['dsh-maintenance_one', 'session-three']);
  registry.failFor.clear();
  const second = await registration.pass();
  expect(second.failures).toEqual([]);
  expect(registry.attached).toEqual(['dsh-maintenance_one', 'session-three', 'dsh-maintenance_two']);
});

it('keeps trying when the Engine is not reachable yet, and reports once', async () => {
  const registry = host();
  const report = vi.fn();
  let reachable = false;
  const registration = new MappedWorkspaceRegistration({ host: registry, report, intervalMs: 1,
    listFolders: async () => {
      if (!reachable) throw new Error('engine is not ready');
      return folders;
    } });
  const stop = registration.start();
  await vi.waitFor(() => { expect(report).toHaveBeenCalledTimes(1); });
  expect(report.mock.calls[0]![0]).toContain('维护引擎暂未接通');
  reachable = true;
  await vi.waitFor(() => { expect(registry.attached).toContain('session-three'); });
  stop();
});
