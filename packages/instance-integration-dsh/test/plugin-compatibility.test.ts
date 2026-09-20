import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createFixtureSandbox } from '../../test-support/src/index.js';
import { inspectDshIntegrationPlugin } from '../src/launcher-discovery.js';
import { checkDshPluginDeclaration } from '../src/plugin-compatibility.js';
import { saveStandaloneInstance } from '../../../apps/engine/src/integrations/standalone.js';

const current = JSON.parse(await readFile(new URL('../../../plugins/dsh-session-maintenance/package.json', import.meta.url), 'utf8'));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });
const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
async function fixture() {
  const box = await createFixtureSandbox('plugin-compatibility'); cleanups.push(box.cleanup);
  const home = join(box.root, 'home'), profile = join(home, 'profiles/web'), runtime = join(box.root, 'runtime');
  const plugin = join(profile, 'node_modules/dsh-session-maintenance');
  const cli = join(runtime, 'node_modules/@deepseek-ai/dsh');
  await mkdir(plugin, { recursive: true }); await mkdir(join(cli, 'lib'), { recursive: true });
  await json(join(cli, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' });
  await writeFile(join(cli, 'lib/bin.js'), '// synthetic');
  const manifest = { ...current, main: 'index.js', exports: { '.': './index.js', './package.json': './package.json' } };
  await json(join(plugin, 'package.json'), manifest);
  await writeFile(join(plugin, 'index.js'), '// synthetic');
  await writeFile(join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: session-maintenance\n      name: dsh-session-maintenance\n');
  await json(join(profile, 'package.json'), { dsh: { profile: { bundles: ['dsh-session-maintenance'] } } });
  const inspect = () => inspectDshIntegrationPlugin({ cliManifest: join(cli, 'package.json'), profileManifest: join(profile, 'package.json'), roots: [home, runtime], hostVersion: '0.1.5-rc.2' });
  return { box, home, profile, runtime, plugin, manifest, inspect };
}
it('accepts the current declaration and a later patch with the same contract, without a version allowlist update', async () => {
  const f = await fixture(); expect(await f.inspect()).toMatchObject({ ready: true });
  await json(join(f.plugin, 'package.json'), { ...f.manifest, version: '0.2.26-rc2.999' });
  expect(await f.inspect()).toMatchObject({ ready: true });
});
it.each([
  ['protocol', { id: 'maintenance-dsh-integration', version: 2 }, 'PROTOCOL_UNSUPPORTED'],
  ['hostVersions', ['0.1.5-rc.3'], 'HOST_UNSUPPORTED'],
  ['adapterId', 'other-adapter', 'HOST_UNSUPPORTED'],
  ['sessionFormats', ['other-format'], 'FORMAT_UNSUPPORTED'],
  ['capabilities', ['canonical-session-projection'], 'CAPABILITY_MISSING'],
  ['schemaVersion', 2, 'DECLARATION_INVALID'],
])('rejects incompatible %s even for a legacy allowlisted version', async (key, value, code) => {
  const f = await fixture();
  await json(join(f.plugin, 'package.json'), { ...f.manifest, version: '0.2.26-rc2.34', dshMaintenanceIntegration: { ...current.dshMaintenanceIntegration, [key as string]: value } });
  expect(await f.inspect()).toMatchObject({ ready: false, issue: { code: `INSTANCE_PLUGIN_${code}` } });
});
it('freezes legacy compatibility and rejects undeclared future packages', () => {
  expect(checkDshPluginDeclaration({ version: '0.2.26-rc2.35' }, '0.1.5-rc.2')).toBeNull();
  expect(checkDshPluginDeclaration({ version: current.version }, '0.1.5-rc.2')?.code).toBe('INSTANCE_PLUGIN_DECLARATION_MISSING');
  expect(checkDshPluginDeclaration({ version: '0.2.26-rc2.999' }, '0.1.5-rc.2')?.code).toBe('INSTANCE_PLUGIN_DECLARATION_MISSING');
  expect(checkDshPluginDeclaration(current, '0.1.2-rc.1')?.code).toBe('INSTANCE_PLUGIN_HOST_UNSUPPORTED');
});
it('reports disabled, broken bundle and missing entry separately', async () => {
  const f = await fixture();
  await json(join(f.profile, 'package.json'), { dsh: { profile: { bundles: [] } } });
  expect(await f.inspect()).toMatchObject({ issue: { code: 'INSTANCE_PLUGIN_DISABLED' } });
  await json(join(f.profile, 'package.json'), { dsh: { profile: { bundles: ['dsh-session-maintenance'] } } });
  await writeFile(join(f.plugin, 'cordis.patch.yml'), '[]');
  expect(await f.inspect()).toMatchObject({ issue: { code: 'INSTANCE_PLUGIN_BUNDLE_INVALID' } });
  await writeFile(join(f.plugin, 'cordis.patch.yml'), '- insert:\n    - id: session-maintenance\n      name: dsh-session-maintenance\n');
  await unlink(join(f.plugin, 'index.js'));
  expect(await f.inspect()).toMatchObject({ issue: { code: 'INSTANCE_PLUGIN_RESOLUTION_MISMATCH' } });
});
it('preserves the specific compatibility error through standalone registration', async () => {
  const f = await fixture();
  await json(join(f.plugin, 'package.json'), { ...f.manifest, dshMaintenanceIntegration: { ...current.dshMaintenanceIntegration, protocol: { id: 'maintenance-dsh-integration', version: 2 } } });
  await expect(saveStandaloneInstance(join(f.box.root, 'state'), { schemaVersion: 1, instanceId: 'synthetic', name: 'Synthetic', profileId: 'web', homeRoot: f.home, versionRoot: f.runtime, runtimeVersion: '0.1.5-rc.2', runtimeUrl: 'http://127.0.0.1:19876' })).rejects.toMatchObject({ code: 'INSTANCE_PLUGIN_PROTOCOL_UNSUPPORTED' });
});
