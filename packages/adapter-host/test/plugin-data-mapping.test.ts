import { expect, it } from 'vitest';
import { PluginDataMappingRegistry } from '../src/plugin-data-mapping.js';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const record = { namespace: 'synthetic-plugin', dataType: 'canvas', recordId: 'source-one', value: { nodes: [{ label: '保留', extras: [null, false, 5] }] } };
const target = { endpointId: 'synthetic-host', sessionId: 'one', context: {} };
it('retains data without restoring when no plugin adapter or successful handshake exists', async () => {
  const registry = new PluginDataMappingRegistry(), source = JSON.stringify(record);
  expect((await registry.begin().map(record, target)).status).toBe('retained-only');
  registry.register({ namespace: record.namespace, handshake: async () => false, restore: async () => { throw new Error('must not restore'); }, verify: async () => true });
  expect((await registry.begin().map(record, target)).status).toBe('retained-only'); expect(JSON.stringify(record)).toBe(source);
});
it('lets the adapter restore its own file and verifies through the plugin reader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-restore-SYNTHETIC-')), path = (id: string) => join(root, `${id}.json`);
  try {
    const registry = new PluginDataMappingRegistry(), readAsPlugin = async (id: string) => JSON.parse(await readFile(path(id), 'utf8'));
    registry.register({ namespace: record.namespace, handshake: async () => true,
      restore: async (item, destination) => { await writeFile(path(destination.sessionId), JSON.stringify(item.value)); return { kind: 'plugin-storage', receiptId: item.recordId }; },
      verify: async (item, _placement, destination) => JSON.stringify(await readAsPlugin(destination.sessionId)) === JSON.stringify(item.value) });
    const mapping = registry.begin(); expect((await mapping.map(record, target)).status).toBe('mapped');
    await mapping.map({ ...record, value: { different: true } }, { ...target, sessionId: 'two' }); await mapping.verify();
    expect(await readAsPlugin('one')).toEqual(record.value); expect(await readAsPlugin('two')).toEqual({ different: true });
    await writeFile(path('one'), '{}'); await expect(mapping.verify()).rejects.toThrow('not usable');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('fails verification if the plugin is removed after mapping', async () => {
  const registry = new PluginDataMappingRegistry(), unregister = registry.register({ namespace: record.namespace, handshake: async () => true,
    restore: async item => ({ kind: 'host-event', value: item.value }), verify: async () => true });
  const mapping = registry.begin(); await mapping.map(record, target); unregister(); await expect(mapping.verify()).rejects.toThrow('not usable');
});
