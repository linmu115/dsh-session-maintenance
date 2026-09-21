import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apply } from '../src/index.js';
import {
  IDENTITY_DECLARATION_FILE,
  PLACEHOLDER_INSTANCE_ID,
  PLACEHOLDER_PROFILE_ID,
  identityDeclaration,
  undeclaredIdentityMessage,
} from '../src/instance-identity.js';

/**
 * The plugin package is portable, so both halves of the instance identity — the instance id and
 * the profile id — only ever arrive from the machine's own profile patch. These tests pin both
 * halves of that rule: a machine that declared only one of them (or neither) is refused a
 * takeover and told how to declare, and a machine that declared both keeps the full handshake.
 */
const DECLARED_INSTANCE_ID = 'i-27c4d5a7-bdb5-4b8a-8d95-6267f47499c5';
const DECLARED_PROFILE_ID = 'independent';

const MANAGED_VARIABLES = [
  'DSH_SESSION_MAINTENANCE_CONNECTION_PRIMARY',
  'DSH_SESSION_MAINTENANCE_STATE_ROOT',
  'DSH_SESSION_MAINTENANCE_LAUNCH_PROFILE',
  'DSH_SESSION_MAINTENANCE_CORE_RECEIPT',
  'DSH_SESSION_MAINTENANCE_CORE_BINDING_RECEIPT',
  'DSH_SESSION_MAINTENANCE_CORE_RECEIPT_SHA256',
  'DSH_SESSION_MAINTENANCE_CORE_BINDING_SHA256',
  'DSH_SESSION_MAINTENANCE_NATIVE_EXTENSIONS',
  'DSH_HOME',
] as const;

const roots: string[] = [];
const saved = new Map<string, string | undefined>();

afterEach(async () => {
  vi.restoreAllMocks();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function syntheticState() {
  const root = await mkdtemp(join(tmpdir(), 'SYNTHETIC-instance-identity-'));
  roots.push(root);
  for (const key of MANAGED_VARIABLES) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.DSH_SESSION_MAINTENANCE_CONNECTION_PRIMARY = join(root, 'connection.json');
  process.env.DSH_HOME = root;
  return root;
}

async function loadPlugin(dshInstanceId: string, profileId: string) {
  const exits: number[] = [];
  const endpoints: string[] = [];
  const ctx = new Context();
  ctx.provide('webServer', {
    register: vi.fn((input: { readonly path: string }) => { endpoints.push(input.path); return () => undefined; }),
  } as never);
  ctx.provide('appExit', ((code: number) => { exits.push(code); }) as never);
  // The plugin reports through `ctx.logger` when the host has one (Cordis ships a logger) and
  // falls back to console.warn otherwise; capture whichever this context actually uses.
  const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const logger = (ctx as unknown as { logger?: { warn(message: string): void } }).logger;
  const loggerWarn = logger === undefined ? undefined : vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const host = await ctx.plugin({
    inject: ['webServer', 'appExit'],
    apply: child => apply(child as never, { connectionId: 'primary', dshInstanceId, profileId }),
  });
  return { exits, endpoints,
    reported: () => [...consoleWarn.mock.calls, ...loggerWarn?.mock.calls ?? []].map(call => String(call[0])),
    dispose: async () => { await host.dispose(); await ctx.fiber.dispose(); } };
}

describe('machine-local instance identity', () => {
  it('declares the identity only when both the instance id and the profile id are real', () => {
    expect(identityDeclaration(DECLARED_INSTANCE_ID, DECLARED_PROFILE_ID))
      .toEqual({ declared: true, instanceId: DECLARED_INSTANCE_ID, profileId: DECLARED_PROFILE_ID });
  });

  it('treats either placeholder, and either empty value, as "not declared"', () => {
    // Defaults shipped by the package: both placeholders.
    expect(identityDeclaration(PLACEHOLDER_INSTANCE_ID, PLACEHOLDER_PROFILE_ID))
      .toMatchObject({ declared: false, instanceId: PLACEHOLDER_INSTANCE_ID, profileId: PLACEHOLDER_PROFILE_ID });
    // Half a declaration is not a declaration: the Engine matches a lease on both fields.
    expect(identityDeclaration(PLACEHOLDER_INSTANCE_ID, DECLARED_PROFILE_ID))
      .toMatchObject({ declared: false, instanceId: PLACEHOLDER_INSTANCE_ID });
    expect(identityDeclaration(DECLARED_INSTANCE_ID, PLACEHOLDER_PROFILE_ID))
      .toMatchObject({ declared: false, profileId: PLACEHOLDER_PROFILE_ID });
    // Empty and whitespace-only values are the same "not declared" answer, trimmed.
    expect(identityDeclaration('   ', '   ')).toMatchObject({ declared: false, instanceId: '', profileId: '' });
    expect(identityDeclaration(DECLARED_INSTANCE_ID, '   ')).toMatchObject({ declared: false, profileId: '' });
    expect(identityDeclaration('   ', DECLARED_PROFILE_ID)).toMatchObject({ declared: false, instanceId: '' });
  });

  it('names exactly the missing fields in the operator-facing message', () => {
    const bothMissing = undeclaredIdentityMessage();
    expect(bothMissing).toContain('本机未声明实例身份');
    expect(bothMissing).toContain(IDENTITY_DECLARATION_FILE);
    expect(bothMissing).toContain('id: session-maintenance');
    expect(bothMissing).toContain('dshInstanceId、profileId');
    expect(identityDeclaration(PLACEHOLDER_INSTANCE_ID, PLACEHOLDER_PROFILE_ID).message).toBe(bothMissing);
    // A zero-argument call keeps meaning "both missing", so existing call sites stay valid.
    expect(undeclaredIdentityMessage(['dshInstanceId', 'profileId'])).toBe(bothMissing);
    expect(undeclaredIdentityMessage(['profileId'])).toContain('（profileId 仍为空');
    expect(undeclaredIdentityMessage(['dshInstanceId'])).toContain('（dshInstanceId 仍为空');
    expect(identityDeclaration(DECLARED_INSTANCE_ID, PLACEHOLDER_PROFILE_ID).message)
      .toBe(undeclaredIdentityMessage(['profileId']));
  });

  it('refuses the takeover handshake without a declared identity, and still loads', async () => {
    const root = await syntheticState();
    const loaded = await loadPlugin(PLACEHOLDER_INSTANCE_ID, PLACEHOLDER_PROFILE_ID);
    try {
      expect(loaded.exits).toEqual([]);
      // No liveness endpoint and no lease file: nothing claims an instance that does not exist.
      expect(loaded.endpoints).not.toContain('/dsh-session-maintenance/instance/lease');
      await expect(stat(join(root, 'handshakes'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(loaded.reported().some(message => message.includes('本机未声明实例身份'))).toBe(true);
      const complaint = loaded.reported().find(message => message.includes('本机未声明实例身份')) ?? '';
      expect(complaint).toContain(IDENTITY_DECLARATION_FILE);
      expect(complaint).toContain('id: session-maintenance');
      // The rest of the plugin is still installed: the proxy and gateway endpoints exist.
      expect(loaded.endpoints).toContain('/dsh-session-maintenance/api');
      expect(loaded.endpoints).toContain('/dsh-session-maintenance/core');
    } finally { await loaded.dispose(); }
  });

  it('stands down when only the profile id is still the placeholder', async () => {
    const root = await syntheticState();
    const loaded = await loadPlugin(DECLARED_INSTANCE_ID, PLACEHOLDER_PROFILE_ID);
    try {
      expect(loaded.exits).toEqual([]);
      expect(loaded.endpoints).not.toContain('/dsh-session-maintenance/instance/lease');
      await expect(stat(join(root, 'handshakes'))).rejects.toMatchObject({ code: 'ENOENT' });
      const complaint = loaded.reported().find(message => message.includes('本机未声明实例身份')) ?? '';
      expect(complaint).toContain('profileId');
      // Standing down is still not standing still: the instance keeps its gateway and proxy.
      expect(loaded.endpoints).toContain('/dsh-session-maintenance/api');
      expect(loaded.endpoints).toContain('/dsh-session-maintenance/core');
    } finally { await loaded.dispose(); }
  });

  it('stands down when only the instance id is still the placeholder', async () => {
    const root = await syntheticState();
    const loaded = await loadPlugin(PLACEHOLDER_INSTANCE_ID, DECLARED_PROFILE_ID);
    try {
      expect(loaded.exits).toEqual([]);
      expect(loaded.endpoints).not.toContain('/dsh-session-maintenance/instance/lease');
      await expect(stat(join(root, 'handshakes'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await loaded.dispose(); }
  });

  it('keeps the full handshake once the machine declares both halves', async () => {
    const root = await syntheticState();
    const loaded = await loadPlugin(DECLARED_INSTANCE_ID, DECLARED_PROFILE_ID);
    try {
      expect(loaded.exits).toEqual([]);
      expect(loaded.endpoints).toContain('/dsh-session-maintenance/instance/lease');
      expect(loaded.reported().some(message => message.includes('本机未声明实例身份'))).toBe(false);
      const leases = await stat(join(root, 'handshakes'));
      expect(leases.isDirectory()).toBe(true);
    } finally { await loaded.dispose(); }
  });
});
