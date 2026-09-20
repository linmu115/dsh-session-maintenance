import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { AdapterCatalog } from '../src/adapter-catalog.js';
import { inspectConfiguredInstance } from '../src/integrations/standalone.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'SYNTHETIC-adapter-catalog-')); roots.push(root);
  const directory = join(root, 'adapters', 'sample'); await mkdir(directory, { recursive: true });
  const manifest = { protocolVersion: 1, packageId: 'sample', version: '1.0.0', entries: [{ kind: 'business', id: 'sample-notes', namespace: 'sample-notes', engine: 'entry.mjs' }] };
  await writeFile(join(directory, 'maintenance-adapter.json'), JSON.stringify(manifest));
  return { root, directory, manifest, catalog: new AdapterCatalog(root) };
}
it('discovers disabled packages without executing them and retains independent enable choices', async () => {
  const f = await fixture(); await writeFile(join(f.directory, 'entry.mjs'), 'throw new Error("must not load disabled entry");');
  expect((await f.catalog.discover()).entries[0]?.enabled).toBe(false);
  expect((await f.catalog.load()).issues).toEqual([]);
  await f.catalog.setEnabled('sample-notes', true);
  expect((await new AdapterCatalog(f.root).load()).issues[0]?.message).toContain('must not load');
  await f.catalog.setEnabled('sample-notes', false);
  expect((await new AdapterCatalog(f.root).discover()).entries[0]?.enabled).toBe(false);
});
it('loads a third-party namespace without editing Engine and disabling does not touch business data', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'entry.mjs'), 'export const adapter={namespace:"sample-notes",label:"Sample notes",pluginVersions:["1"],schemaVersions:[1],capabilities:{read:true,write:true,delete:true,restore:true,panel:true,context:false},validate(){},summarize(){return "sample"}};');
  await f.catalog.setEnabled('sample-notes', true);
  expect((await f.catalog.load()).business[0]?.namespace).toBe('sample-notes');
  await f.catalog.setEnabled('sample-notes', false);
  expect((await f.catalog.load()).business).toEqual([]);
});
it('reports an incompatible manifest or escaping entry without executing it', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'maintenance-adapter.json'), JSON.stringify({ ...f.manifest, entries: [{ ...f.manifest.entries[0], engine: '../outside.mjs' }] }));
  expect((await f.catalog.discover()).entries).toEqual([]);
  expect((await f.catalog.discover()).issues).toHaveLength(1);
  await expect(f.catalog.setEnabled('sample-notes', true)).rejects.toThrow('invalid');
});

it('uses an explicitly selected third-party host inspector without an Engine version list and fails closed after disable', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'maintenance-adapter.json'), JSON.stringify({ ...f.manifest, entries: [{ kind: 'instance', id: 'future-host', engine: 'entry.mjs', worker: 'entry.mjs' }] }));
  await writeFile(join(f.directory, 'entry.mjs'), `export const adapter = {
    manifest: {schemaVersion:1,id:'future-host',displayName:'Future fixture',adapterApiVersion:1,packageVersion:'1.0.0',testedDshVersions:['9.9.9'],declaredDshRange:'9.9.9',capabilities:['session-persistence']},
    hostIntegration: { async inspect(config) { return { instanceId:config.instanceId, launcherDataRoot:null,
      target:{id:'synthetic-target',kind:'dsh',name:config.name,version:config.runtimeVersion,profile:config.profileId,adapterId:'future-host',status:'available',capabilities:[],issues:[]},
      fingerprint:'fixture', homeRoot:config.homeRoot,versionRoot:config.versionRoot,profileRoot:config.homeRoot,cliPath:null,packageVersions:{},pluginReady:true }; } }
  };`);
  const config = { schemaVersion: 1 as const, adapterId: 'future-host', instanceId: 'synthetic', profileId: 'web', name: 'Synthetic', runtimeVersion: '9.9.9', homeRoot: f.root, versionRoot: f.root, runtimeUrl: 'http://127.0.0.1:19001' };
  await f.catalog.setEnabled('future-host', true);
  expect((await inspectConfiguredInstance(f.root, config)).target.adapterId).toBe('future-host');
  await f.catalog.setEnabled('future-host', false);
  await expect(inspectConfiguredInstance(f.root, config)).rejects.toThrow('未启用');
});
