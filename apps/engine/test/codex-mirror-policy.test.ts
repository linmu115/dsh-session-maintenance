import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexMirrorPolicy } from '../src/codex-mirror-policy.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'maintenance-mirror-policy-test-')); roots.push(root);
  const inspect = vi.fn(async () => ({ compatible: true, bidirectional: true, version: 'fixture', reason: 'compatible fixture' }));
  const policy = new CodexMirrorPolicy(root, inspect); await policy.initialize();
  return { root, inspect, policy };
}
it('does not inspect or enable Codex in a fresh installation, and checking does not enable anything', async () => {
  const { policy, inspect } = await fixture();
  expect(inspect).not.toHaveBeenCalled();
  expect(policy.status().active).toEqual({ mirror: false, bidirectional: false, background: false });
  await policy.check();
  expect(policy.status().active).toEqual({ mirror: false, bidirectional: false, background: false });
});
it('requires a successful check and keeps three preferences independent', async () => {
  const { policy } = await fixture();
  await expect(policy.configure({ ...policy.status().preferences, mirror: true })).rejects.toThrow('请先检查');
  await policy.check();
  await policy.configure({ ...policy.status().preferences, mirror: true });
  expect(policy.status().active).toEqual({ mirror: true, bidirectional: false, background: false });
  await policy.configure({ ...policy.status().preferences, bidirectional: true });
  expect(policy.status().active.background).toBe(false);
});
it('remembers explicit choices but rechecks at startup and pauses on incompatibility', async () => {
  const { root, policy } = await fixture(); await policy.check();
  await policy.configure({ ...policy.status().preferences, mirror: true, background: true });
  const restarted = new CodexMirrorPolicy(root, async () => ({ compatible: false, bidirectional: false, reason: 'changed environment' }));
  await restarted.initialize();
  expect(restarted.status().preferences.mirror).toBe(true);
  expect(restarted.status().active).toEqual({ mirror: false, bidirectional: false, background: false });
  await expect(restarted.assertMirror()).rejects.toThrow('兼容检查');
});
it('invalidates previous checks after a target change and supports disabling while offline', async () => {
  const { policy } = await fixture(); await policy.check();
  await policy.configure({ ...policy.status().preferences, mirror: true });
  await policy.configure({ ...policy.status().preferences, instanceId: 'another-fixture' });
  expect(policy.status().preferences.mirror).toBe(true);
  expect(policy.status().active.mirror).toBe(false);
  await policy.configure({ ...policy.status().preferences, mirror: false });
  expect(policy.status().preferences.mirror).toBe(false);
});
it('cannot enable unsupported experimental writes or run them in the background', async () => {
  const { root, policy } = await fixture(); await policy.check();
  await policy.configure({ ...policy.status().preferences, bidirectional: true, background: true });
  const readonly = new CodexMirrorPolicy(root, async () => ({ compatible: true, bidirectional: false, reason: 'read only' }));
  await readonly.initialize();
  expect(readonly.status().active).toEqual({ mirror: false, bidirectional: false, background: false });
  await readonly.configure({ ...readonly.status().preferences, bidirectional: false });
  await expect(readonly.configure({ ...readonly.status().preferences, bidirectional: true })).rejects.toThrow('不提供双向');
});
