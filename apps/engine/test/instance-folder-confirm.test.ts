import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { declaredIdentityFromPatch } from '@linmu/dsh-instance-integration-dsh/launcher-discovery';
import { InstanceIntegrationService } from '../src/integrations/service.js';
import { PENDING_SELECTION_FILE, savePendingSelection } from '../src/integrations/pending-selection.js';
import type { DiscoveredIntegration } from '../src/integrations/launcher-discovery.js';

/**
 * The declared identity is what Maintenance matches an instance by, and it is not the profile's
 * directory name: the plugin publishes the id from its own patch row, so registering the directory
 * name produces an instance the plugin can never reach.
 */
const PATCH = `
- id: webserver
  config:
    host: 127.0.0.1
    port: 19876
- id: session-maintenance
  config:
    connectionId: primary
    dshInstanceId: i-27c4d5a7-bdb5-4b8a-8d95-6267f47499c5
    profileId: web-i27c4
`;

const declared = { instanceId: 'i-27c4d5a7-bdb5-4b8a-8d95-6267f47499c5', profileId: 'web-i27c4' };
const CLOCK = () => '2026-09-22T00:00:00.000Z';

it('reads the declared identity from the plugin row of a profile patch', () => {
  expect(declaredIdentityFromPatch([{ id: 'webserver', config: { port: 19876 } },
    { id: 'session-maintenance', config: { connectionId: 'primary', dshInstanceId: declared.instanceId, profileId: declared.profileId } }]))
    .toEqual({ ...declared, declared: true });
  // The portable placeholders mean "this machine declared nothing", exactly as the plugin decides.
  expect(declaredIdentityFromPatch([{ id: 'session-maintenance', config: { dshInstanceId: 'dsh-web', profileId: 'web' } }]))
    .toEqual({ instanceId: '', profileId: '', declared: false });
  expect(declaredIdentityFromPatch([{ id: 'session-maintenance', config: { dshInstanceId: declared.instanceId } }]))
    .toEqual({ instanceId: '', profileId: '', declared: false });
  expect(declaredIdentityFromPatch([{ id: 'webserver', config: {} }])).toEqual({ instanceId: '', profileId: '', declared: false });
  expect(declaredIdentityFromPatch(undefined)).toEqual({ instanceId: '', profileId: '', declared: false });
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** A write scope that just runs the callback: the recorded state is what these tests exercise. */
const writes = { run: async <T>(_name: string, callback: () => Promise<T>): Promise<T> => callback(),
  assertInScope: () => undefined } as never;

/** A Home whose `web` profile declares the identity and whose `plain` profile declares nothing. */
async function fixture() {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-confirm-selection-'));
  roots.push(stateRoot);
  const homeRoot = join(stateRoot, 'home');
  const webRoot = join(homeRoot, 'profiles', 'web');
  const plainRoot = join(homeRoot, 'profiles', 'plain');
  await mkdir(webRoot, { recursive: true });
  await mkdir(plainRoot, { recursive: true });
  await writeFile(join(webRoot, 'cordis.patch.yml'), PATCH);
  await writeFile(join(plainRoot, 'cordis.patch.yml'), '[]');
  const pendingId = `select-${Math.random().toString(16).slice(2)}`;
  await savePendingSelection(stateRoot, {
    pendingId, homeRoot, suggestedInstanceId: 'home',
    profiles: [{ profileId: 'web', root: webRoot, web: true }, { profileId: 'plain', root: plainRoot, web: false }],
    runtimeVersion: '0.1.5-rc.2', versionRoot: join(homeRoot, 'runtime'), cliPath: join(homeRoot, 'runtime', 'bin.js'),
    createdAt: CLOCK(),
  }, CLOCK);
  return { stateRoot, homeRoot, webRoot, plainRoot, pendingId };
}

function serviceFor(input: { readonly stateRoot: string; readonly discover?: () => Promise<{ launcherDetected: boolean; targets: DiscoveredIntegration[] }> }) {
  return new InstanceIntegrationService({
    stateRoot: input.stateRoot, writes,
    discover: input.discover ?? (async () => ({ launcherDetected: false, targets: [] })),
    installation: { stateRoot: input.stateRoot, engineEntry: 'engine.mjs' },
    verifyAdapter: async () => undefined, clock: CLOCK,
  } as never);
}

it('records a checked folder, and confirming goes through the recorded id', async () => {
  const f = await fixture();
  // The record is what confirming reads, so a caller only ever names an id and a profile.
  const stored = JSON.parse(await readFile(join(f.stateRoot, PENDING_SELECTION_FILE), 'utf8'));
  expect(stored.selections).toHaveLength(1);
  expect(stored.selections[0]).toMatchObject({ pendingId: f.pendingId, homeRoot: f.homeRoot, createdAt: CLOCK() });
  expect(stored.selections[0].profiles.map((profile: { profileId: string }) => profile.profileId)).toEqual(['web', 'plain']);
});

it('refuses an unknown check instead of trusting a caller-sent path', async () => {
  const f = await fixture();
  await expect(serviceFor({ stateRoot: f.stateRoot }).confirmInstanceSelection({ pendingId: 'select-nope', profileId: 'web' }))
    .rejects.toMatchObject({ code: 'INSTANCE_SELECTION_UNKNOWN' });
});

it('refuses a profile the Engine did not list for that check', async () => {
  const f = await fixture();
  await expect(serviceFor({ stateRoot: f.stateRoot }).confirmInstanceSelection({ pendingId: f.pendingId, profileId: 'not-in-this-home' }))
    .rejects.toMatchObject({ code: 'INSTANCE_PROFILE_NOT_SELECTED' });
});

it('refuses a profile that declares no identity, and says how to declare it', async () => {
  const f = await fixture();
  const refusal = await serviceFor({ stateRoot: f.stateRoot })
    .confirmInstanceSelection({ pendingId: f.pendingId, profileId: 'plain' })
    .then(() => undefined, error => error as { code?: string; message?: string });
  expect(refusal?.code).toBe('INSTANCE_IDENTITY_UNDECLARED');
  expect(refusal?.message).toContain('cordis.patch.yml');
  expect(refusal?.message).toContain('dshInstanceId');
  // The placeholders are named so an operator cannot "declare" the placeholder by accident.
  expect(refusal?.message).toContain('dsh-web');
});

it('registers the declared identity of the confirmed profile as a directory connection', async () => {
  const f = await fixture();
  const service = serviceFor({ stateRoot: f.stateRoot });
  const registered: Record<string, unknown>[] = [];
  const directory = { targets: [], launcherDetected: false, nativeSyncSupported: false as const, nativeSyncReason: '合成目录' };
  // Registration itself runs the real adapter verification, which needs a full installed instance;
  // this test pins the *request* the confirm step builds, which is where the identity is decided.
  (service as unknown as { registerStandalone: (config: Record<string, unknown>) => Promise<unknown> }).registerStandalone =
    async config => { registered.push(config); return directory; };
  const listed = await service.confirmInstanceSelection({ pendingId: f.pendingId, profileId: 'web' });
  expect(listed).toBe(directory);
  expect(registered).toHaveLength(1);
  expect(registered[0]).toMatchObject({
    schemaVersion: 1,
    // Both halves come from the profile's own patch, never from the directory name or the caller.
    instanceId: declared.instanceId,
    profileId: declared.profileId,
    homeRoot: f.homeRoot,
    versionRoot: join(f.homeRoot, 'runtime'),
    runtimeVersion: '0.1.5-rc.2',
    runtimeUrl: 'http://127.0.0.1:19876',
    name: 'home',
  });
  // A confirmed selection is spent: repeating it must not register twice.
  await expect(service.confirmInstanceSelection({ pendingId: f.pendingId, profileId: 'web' }))
    .rejects.toMatchObject({ code: 'INSTANCE_SELECTION_UNKNOWN' });
  expect(registered).toHaveLength(1);
});

it('keeps a workspace join refused until the instance is registered, and answers once it is', async () => {
  const f = await fixture();
  let registered = false;
  const target: DiscoveredIntegration = {
    target: { id: 'dsh-merged', kind: 'dsh', name: 'home', version: '0.1.5-rc.2', profile: declared.profileId,
      status: 'available', adapterId: 'dsh-0.1.5', capabilities: [], issues: [] },
    instanceId: declared.instanceId, connectionKind: 'directory', fingerprint: 'fingerprint', launcherDataRoot: null,
    homeRoot: f.homeRoot, versionRoot: join(f.homeRoot, 'runtime'), profileRoot: f.webRoot, cliPath: join(f.homeRoot, 'runtime', 'bin.js'),
    packageVersions: {}, pluginReady: true,
  };
  const mapped: string[] = [];
  const service = new InstanceIntegrationService({
    stateRoot: f.stateRoot, writes,
    discover: async () => ({ launcherDetected: false, targets: registered ? [target] : [] }),
    installation: { stateRoot: f.stateRoot, engineEntry: 'engine.mjs' }, verifyAdapter: async () => undefined,
    mapWorkspace: async ({ request }: { request: { workspaceId: string } }) => {
      mapped.push(request.workspaceId);
      return { workspaceId: request.workspaceId, created: true, mapped: ['s1'], alreadyPresent: [], failures: [] };
    },
  } as never);
  const joinRequest = { instanceId: declared.instanceId, profileId: declared.profileId, workspaceId: 'workspace-a',
    workspaceName: '工作区 A', workspacePath: 'D:\\合成\\工作区A' };
  // Nothing registered yet: the instance the plugin names must not be matched by guesswork.
  await expect(service.joinWorkspace(joinRequest)).rejects.toMatchObject({ code: 'INTEGRATION_NOT_FOUND' });
  expect(mapped).toEqual([]);
  registered = true;
  const receipt = await service.joinWorkspace(joinRequest);
  expect(receipt.workspaceId).toBe('workspace-a');
  expect(mapped).toEqual(['workspace-a']);
});

it('shows one card per instance, labelled with the source that is actually bound', async () => {
  const f = await fixture();
  const target = (id: string, connectionKind: 'directory' | 'launcher', launcherDataRoot: string | null): DiscoveredIntegration => ({
    target: { id, kind: 'dsh', name: 'home', version: '0.1.5-rc.2', profile: declared.profileId,
      status: 'available', adapterId: 'dsh-0.1.5', capabilities: [
        { id: 'projection', label: '会话读取与增量提交', status: 'supported', detail: 'ok' },
        { id: 'lifecycle', label: '随实例启动和收尾', status: 'unchecked', detail: 'x' }], issues: [] },
    instanceId: declared.instanceId, connectionKind, fingerprint: 'fingerprint-a', launcherDataRoot,
    homeRoot: f.homeRoot, versionRoot: join(f.homeRoot, 'runtime'), profileRoot: f.webRoot, cliPath: null,
    packageVersions: {}, pluginReady: true,
  });
  const service = serviceFor({ stateRoot: f.stateRoot, discover: async () => ({ launcherDetected: true,
    // The same instance reached twice: once through the Launcher catalog, once as a folder.
    targets: [target('dsh-launcher', 'launcher', f.homeRoot), target('dsh-directory', 'directory', null)] }) });
  const directory = await service.list();
  expect(directory.targets).toHaveLength(1);
  expect(directory.targets[0]!.profile).toBe(declared.profileId);
  // Nothing is bound yet, so the folder connection is the one that survives: it asks nothing of
  // the instance at launch.
  expect(directory.targets[0]!.connectionKind).toBe('directory');
});
