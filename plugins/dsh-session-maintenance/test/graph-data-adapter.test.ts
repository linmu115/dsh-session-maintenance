import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { GraphDataAdapter } from '../src/graph-data-adapter.js';
import type { MaintenanceExtensionBridge } from '../src/extension-data.js';
import { thoughtDagAdapter } from '../../../packages/extension-knowledge/src/index.js';
const id = (value: string) => `graph-${createHash('sha256').update(value).digest('hex')}`;
const oldGraph = { managedSchema: 2, ownerSessionId: 'logical-owner', nodes: [{ id: 'a', position: { x: 1, y: 2 }, data: { kind: 'session', label: 'Source', logicalSessionId: 'logical-source' } }], edges: [] };
function fixture() {
  const rows = new Map<string, any>([['old-graph', { objectId: 'old-graph', revision: 5, deleted: false, content: { schemaVersion: 2, title: 'Old graph', body: oldGraph } }]]);
  let conflict = false;
  const bridge = { async scopedPanels() { return [{ scope: { namespace: 'thoughtdag' }, status: 'ready' }] },
    async list() { return { items: [...rows.values()].map(row => ({ objectId: row.objectId })), nextCursor: null } },
    async get(_: string, key: string) { return { object: rows.get(key) } },
    async save(_: string, key: string, revision: number, content: any, deleted: boolean) {
      thoughtDagAdapter.validate(content);
      if (conflict || (rows.get(key)?.revision ?? 0) !== revision) return { status: 'conflict' };
      const object = { objectId: key, revision: revision + 1, content, deleted }; rows.set(key, object); return { status: 'saved', object };
    },
  } as unknown as MaintenanceExtensionBridge;
  const resolve = async (target: any) => { const suffix = (target.nativeSessionId ?? target.logicalSessionId).split('-').at(-1); return { nativeSessionId: 'native-' + suffix, logicalSessionId: 'logical-' + suffix, title: suffix } };
  return { rows, adapter: new GraphDataAdapter(bridge, { resolve }), conflict() { conflict = true } };
}
it('restores schema 2 graph identities and writes schema 3 through the adapter without overwriting the original', async () => {
  const f = fixture(), [restored] = await f.adapter.read('thoughtdag', 'native-owner');
  expect(restored!.objectId).toBe(id('native-owner')); expect(restored!.revision).toBe(5);
  expect((restored!.content as any).graph.nodes[0].data.logicalSessionId).toBe('native-source');
  await f.adapter.commit({ ...restored!, revision: 6 });
  expect(f.rows.get('old-graph').content.body).toEqual(oldGraph);
  expect(f.rows.get(id('logical-owner')).content.schemaVersion).toBe(3);
  expect((await f.adapter.read('thoughtdag', 'native-owner'))[0]!.revision).toBe(6);
})
it('retains remote tombstones and refuses conflicting saves', async () => {
  const f = fixture(), [restored] = await f.adapter.read('thoughtdag', 'native-owner');
  await f.adapter.commit({ ...restored!, revision: 6, deleted: true });
  expect((await f.adapter.read('thoughtdag', 'native-owner'))[0]!.deleted).toBe(true);
  f.conflict(); await expect(f.adapter.commit({ ...restored!, revision: 7 })).rejects.toThrow('真源已更新');
})
