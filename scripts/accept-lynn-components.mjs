import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const args = process.argv.slice(2);
const source = name => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`Missing ${name}`); return resolve(args[i + 1]).replaceAll('\\', '/'); };
const core = source('--core'), sticker = source('--sticker'), dag = source('--dag');
const root = resolve('.').replaceAll('\\', '/');
const temporary = await mkdtemp(join(tmpdir(), 'lynn-readers-SYNTHETIC-'));
try {
  const entry = `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AnnotationStore } from ${JSON.stringify(core + '/src/host/store.ts')};
import { LocalSessionExtensionData } from ${JSON.stringify(core + '/src/host/session-extension-data.ts')};
import { StickerLocalStore } from ${JSON.stringify(sticker + '/src/host/local-store.ts')};
import { createSessionGraph } from ${JSON.stringify(dag + '/lib/session-graph.js')};
import { createLynnAdapter } from ${JSON.stringify(root + '/packages/adapter-lynn/src/runtime.ts')};
import { PluginDataMappingRegistry } from ${JSON.stringify(root + '/packages/adapter-host/src/plugin-data-mapping.ts')};
const table = () => { const rows = new Map(); return { get: key => rows.get(key), entries: () => rows.entries(),
  put: async (key, value) => rows.set(key, structuredClone(value)), delete: async key => rows.delete(key),
  update: async (key, fn) => rows.set(key, structuredClone(fn(rows.get(key)))) }; };
function host(label, pluginNames) {
  const core = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: label });
  const data = new LocalSessionExtensionData(table());
  const stickers = new StickerLocalStore(${JSON.stringify(temporary)} + '/' + label);
  const services = { annotationCore: { store: core }, sessionExtensionData: data,
    stickerBoard: { localStore: stickers, readLocalState: id => stickers.read(id) } };
  const disposers = [], h = { get: name => services[name],
    registry: { values: () => pluginNames.map(name => ({ name, fibers: [{ state: 2 }] })) },
    inject: (_names, fn) => fn(h), effect: fn => disposers.push(fn()) };
  return { core, data, stickers, h, close: () => disposers.reverse().forEach(fn => fn()) };
}
const names = ['dsh-annotation-core', 'thoughtdag', 'dsh-session-sticker-board'];
const a = host('source-profile', names), b = host('target-profile', names), c = host('without-dag', names.filter(name => name !== 'thoughtdag'));
const from = { endpointId: 'source-endpoint', sessionId: 'source-session', context: { profileId: 'source-profile' } };
const to = { endpointId: 'target-endpoint', sessionId: 'target-session', context: { profileId: 'target-profile' } };
try {
  await a.core.addReference(from.sessionId, { expectedRevision: 0, operationId: 'operation-1', setId: 'set-1', referenceId: 'reference-1', createdAt: 1,
    source: { sourceType: 'dsh-message', selectedText: 'synthetic excerpt', locator: { profileId: 'source-profile', sessionId: from.sessionId,
      anchorId: 'anchor-1', role: 'user', occurrence: 0, selectedTextHash: 'sha256:' + createHash('sha256').update('synthetic excerpt').digest('hex') } } });
  const graph = createSessionGraph(a.data, { protocolVersion: 1 }).graph;
  await graph.ensure(from.sessionId);
  const state = await a.stickers.read(from.sessionId);
  await a.stickers.save({ document: state.document, expectedRevision: state.document.revision });
  await a.data.write({ sessionId: from.sessionId, namespace: 'future-plugin', objectId: 'opaque', expectedRevision: 0, deleted: false,
    content: { arbitrary: { values: [null, 1, 'source-session'], sessionId: 'opaque-do-not-rewrite' } } });
  const sourceAdapter = createLynnAdapter(a.h), rows = await sourceAdapter.capture(from), original = JSON.stringify(rows);
  const registry = new PluginDataMappingRegistry(); registry.register(createLynnAdapter(b.h));
  const pass = registry.begin(); await registry.withAccess([to], async () => { for (const row of rows) await pass.map(row, to); await pass.verify(); });
  assert.equal(JSON.stringify(rows), original);
  assert.equal(b.core.readPending(to.sessionId).pending.items[0].locator.sessionId, to.sessionId);
  assert.equal(b.core.readPending(to.sessionId).pending.profileId, 'target-profile');
  assert.equal((await b.stickers.read(to.sessionId)).document.sessionId, to.sessionId);
  const restored = await createSessionGraph(b.data, { protocolVersion: 1 }).graph.ensure(to.sessionId);
  assert.equal(restored.graph.ownerSessionId, to.sessionId);
  assert.equal(restored.graph.nodes[0].data.logicalSessionId, to.sessionId);
  assert.equal(pass.counts.retained, 1);
  assert.equal(b.data.list('future-plugin', to.sessionId).length, 0);
  const absent = createLynnAdapter(c.h); assert.equal(await absent.handshake('dag/extensions'), false);
  assert.equal(await absent.handshake('core/session'), true);
  // A plugin edit after capture must never be overwritten by synchronization.
  const localRows = await sourceAdapter.capture(from);
  await a.core.addReference(from.sessionId, { expectedRevision: 1, operationId: 'operation-2', setId: 'set-1', referenceId: 'reference-2', createdAt: 2,
    source: { sourceType: 'dsh-message', selectedText: 'synthetic excerpt', locator: { profileId: 'source-profile', sessionId: from.sessionId,
      anchorId: 'anchor-2', role: 'user', occurrence: 0, selectedTextHash: 'sha256:' + createHash('sha256').update('synthetic excerpt').digest('hex') } } });
  await assert.rejects(() => sourceAdapter.restore(localRows.find(row => row.dataType === 'core/session'), from), /CHANGED_DURING_SYNC/);
  console.log(JSON.stringify({ status: 'passed', actualReaders: ['AnnotationStore.readPending', 'LocalSessionExtensionData.list', 'ThoughtDAG.ensure', 'StickerLocalStore.read'], sourceUnchanged: true, unknownRetained: true, missingPluginSkipped: true, concurrentEditPreserved: true }));
} finally { a.close(); b.close(); c.close(); }
`;
  const output = join(temporary, 'accept.mjs');
  await build({ stdin: { contents: entry, resolveDir: root, sourcefile: 'lynn-real-readers.ts' }, outfile: output,
    bundle: true, format: 'esm', platform: 'node', target: 'node24', conditions: ['development'],
    banner: { js: 'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);' } });
  await import(pathToFileURL(output).href);
} finally { await rm(temporary, { recursive: true, force: true }); }
