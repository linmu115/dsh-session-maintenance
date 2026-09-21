import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apply } from '../src/index.js';

/**
 * The operator's own instance, running natively with no Maintenance Engine.
 *
 * It is deliberately *not* one of the identities the Engine recorded in
 * `maintenance-required.json`, and installing this plugin must not change that:
 * being absent from that file is what keeps a native instance startable.
 */
const INSTANCE_ID = 'i-27c4d5a7-bdb5-4b8a-8d95-6267f47499c5';

/** Identities the Engine *did* record, as they appear on this machine's state root. */
const RECORDED_ELSEWHERE = [
  { instanceId: 'i-826966a9-df83-46ee-bb89-149564f695f8', profileId: 'web' },
  { instanceId: 'i-7ecb6c19-80a5-4c2e-97e6-484bbfc0e926', profileId: 'web' },
] as const;

/** Environment the plugin reads; every entry is restored after each case. */
const MANAGED_VARIABLES = [
  'DSH_SESSION_MAINTENANCE_CONNECTION_PRIMARY',
  'DSH_SESSION_MAINTENANCE_STATE_ROOT',
  'DSH_SESSION_MAINTENANCE_LAUNCH_PROFILE',
  'DSH_SESSION_MAINTENANCE_CORE_RECEIPT',
  'DSH_SESSION_MAINTENANCE_CORE_BINDING_RECEIPT',
  'DSH_SESSION_MAINTENANCE_CORE_RECEIPT_SHA256',
  'DSH_SESSION_MAINTENANCE_CORE_BINDING_SHA256',
  'DSH_SESSION_MAINTENANCE_NATIVE_EXTENSIONS',
  'DSH_SESSION_MAINTENANCE_RUNTIME_URL',
  'DSH_HOME',
] as const;

const roots: string[] = [];
const saved = new Map<string, string | undefined>();

afterEach(async () => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function remember(key: string): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
}

/**
 * Point every path the plugin resolves at a synthetic directory.
 *
 * The connection descriptor decides the state root, so the handshake file and
 * the required-instance policy both land here: this test never reads or writes
 * the machine's real Engine state, and it never touches a real instance.
 */
async function syntheticState(required?: readonly { readonly instanceId: string; readonly profileId: string }[]) {
  const root = await mkdtemp(join(tmpdir(), 'SYNTHETIC-startup-without-engine-'));
  roots.push(root);
  for (const key of MANAGED_VARIABLES) { remember(key); delete process.env[key]; }
  process.env.DSH_SESSION_MAINTENANCE_CONNECTION_PRIMARY = join(root, 'connection.json');
  process.env.DSH_HOME = root;
  if (required !== undefined) {
    await writeFile(join(root, 'maintenance-required.json'),
      JSON.stringify({ schemaVersion: 1, required }));
  }
  return root;
}

/** Load the plugin the way the host does, capturing the one call that would stop the instance. */
async function loadPlugin(): Promise<{ readonly exits: number[]; readonly endpoints: string[]; readonly dispose: () => Promise<void> }> {
  const exits: number[] = [];
  const endpoints: string[] = [];
  const ctx = new Context();
  ctx.provide('webServer', {
    register: vi.fn((input: { readonly path: string }) => { endpoints.push(input.path); return () => undefined; }),
  } as never);
  ctx.provide('appExit', ((code: number) => { exits.push(code); }) as never);
  const host = await ctx.plugin({
    inject: ['webServer', 'appExit'],
    apply: child => apply(child as never,
      { connectionId: 'primary', dshInstanceId: INSTANCE_ID, profileId: 'web' }),
  });
  return { exits, endpoints, dispose: async () => { await host.dispose(); await ctx.fiber.dispose(); } };
}

describe('an instance that the Engine did not require stays startable with no Engine at all', () => {
  it('loads without throwing and never calls appExit while other identities are required', async () => {
    const root = await syntheticState(RECORDED_ELSEWHERE);
    // The Engine is absent: nothing was ever registered for this connection.
    await expect(stat(join(root, 'connection.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const loaded = await loadPlugin();
    try {
      expect(loaded.exits).toEqual([]);
      // Loading is not a no-op: the takeover handshake still publishes, because
      // the Engine may appear later. That path only reports, it never blocks.
      expect(loaded.endpoints).toContain('/dsh-session-maintenance/instance/lease');
    } finally { await loaded.dispose(); }
  });

  it('loads without throwing when no required-instance policy exists at all', async () => {
    await syntheticState();
    const loaded = await loadPlugin();
    try { expect(loaded.exits).toEqual([]); } finally { await loaded.dispose(); }
  });

  it('still refuses startup for an identity the Engine did require, so the gate is exactly that file', async () => {
    await syntheticState([{ instanceId: INSTANCE_ID, profileId: 'web' }]);
    const exits: number[] = [];
    const ctx = new Context();
    ctx.provide('webServer', { register: vi.fn(() => () => undefined) } as never);
    ctx.provide('appExit', ((code: number) => { exits.push(code); }) as never);
    try {
      await expect(ctx.plugin({
        inject: ['webServer', 'appExit'],
        apply: child => apply(child as never,
          { connectionId: 'primary', dshInstanceId: INSTANCE_ID, profileId: 'web' }),
      })).rejects.toThrow('请先启动');
      expect(exits).toEqual([1]);
    } finally { await ctx.fiber.dispose(); }
  });
});
