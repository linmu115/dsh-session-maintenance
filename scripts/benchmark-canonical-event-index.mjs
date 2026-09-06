import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, platform, release, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { CanonicalSessionEngine } from '../packages/canonical-session-engine/dist/index.js';
import { openMaintenanceDatabase, SqliteCanonicalSessionEngineStore, ZstdContentObjectStore } from '../packages/session-store/dist/index.js';

// The comparison keeps the same version validation/compression/head transaction,
// but forces the previous DELETE + full INSERT index strategy before each write.
class FullRebuildStore extends SqliteCanonicalSessionEngineStore {
  putVersion(version, objectId) {
    this.database.prepare('DELETE FROM canonical_events WHERE logical_session_id = ?').run(version.logicalSessionId);
    super.putVersion(version, objectId);
  }
}
const repo = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const value = (key, fallback) => { const index = args.indexOf(key); return index < 0 ? fallback : args[index + 1]; };
const rounds = Number(value('--rounds', '12'));
const sizes = value('--sizes', '1000,5000').split(',').map(Number);
if (!Number.isSafeInteger(rounds) || rounds < 3 || rounds > 100 || sizes.some(size => !Number.isSafeInteger(size) || size < 1 || size > 50000)) throw new Error('Invalid benchmark bounds');
const output = resolve(repo, value('--output', '.artifacts/sm11-index-benchmark.json'));
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)];
async function bytesIn(root) {
  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) bytes += await bytesIn(path);
    else if (entry.isFile()) bytes += (await stat(path)).size;
    else throw new Error('Unexpected link in synthetic benchmark');
  }
  return bytes;
}
function event(sequence) {
  const text = `Synthetic conversation message ${sequence}. ` + createHash('sha256').update(String(sequence)).digest('hex').repeat(4);
  return { schemaVersion: 1, id: `fixture-${sequence}`, logicalSessionId: 'sm11-fixture', sequence,
    kind: sequence % 2 ? 'assistant-message' : 'user-message', role: sequence % 2 ? 'assistant' : 'user',
    content: { text }, source: { platform: 'codex', instanceId: 'synthetic', sessionId: 'synthetic', eventId: String(sequence), cursor: String(sequence) },
    contentDigest: `sha256:${createHash('sha256').update(text).digest('hex')}`, rawPayload: null, extensions: {} };
}
async function measure(mode, size) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sm11-benchmark-'));
  await writeFile(join(root, '.dsh-synthetic-fixture'), 'SM11 benchmark');
  let database;
  const delay = monitorEventLoopDelay({ resolution: 1 });
  try {
    const path = join(root, 'metadata.sqlite');
    database = openMaintenanceDatabase(path);
    const store = new (mode === 'full-rebuild' ? FullRebuildStore : SqliteCanonicalSessionEngineStore)(database, new ZstdContentObjectStore(root));
    const engine = new CanonicalSessionEngine(store);
    const events = Array.from({ length: size }, (_, index) => event(index));
    const observe = () => engine.observeCodex({ logicalSessionId: 'sm11-fixture', title: 'Synthetic benchmark', tags: [], archivedAt: null,
      workspaceId: null, events, sourceCursor: null, observedAt: '2026-09-06T00:00:00.000Z' });
    await observe();
    database.exec(`CREATE TABLE test_writes (inserted INTEGER, deleted INTEGER);
      INSERT INTO test_writes VALUES (0, 0);
      CREATE TRIGGER test_count_insert AFTER INSERT ON canonical_events BEGIN UPDATE test_writes SET inserted = inserted + 1; END;
      CREATE TRIGGER test_count_delete AFTER DELETE ON canonical_events BEGIN UPDATE test_writes SET deleted = deleted + 1; END;`);
    // One warmup append is excluded from both latency and physical byte counts.
    events.push(event(events.length));
    await observe();
    database.exec('UPDATE test_writes SET inserted = 0, deleted = 0');
    const beforeBytes = await bytesIn(join(root, 'objects'));
    const timings = [];
    delay.enable();
    await setImmediate();
    let receipt;
    for (let index = 0; index < rounds; index++) {
      events.push(event(events.length));
      const start = performance.now();
      receipt = await observe();
      timings.push(performance.now() - start);
      await setImmediate();
    }
    await setImmediate();
    delay.disable();
    const indexWrites = database.prepare('SELECT inserted, deleted FROM test_writes').get();
    const addedObjectBytes = (await bytesIn(join(root, 'objects'))) - beforeBytes;
    const versionCount = database.prepare('SELECT COUNT(*) AS count FROM session_versions').get().count;
    database.close();
    database = undefined;
    const reopenStart = performance.now();
    database = openMaintenanceDatabase(path);
    const reopened = new SqliteCanonicalSessionEngineStore(database, new ZstdContentObjectStore(root));
    const head = await reopened.getVersion(receipt.versionId);
    if (head.events.length !== events.length || database.prepare('SELECT COUNT(*) AS count FROM canonical_events').get().count !== events.length) throw new Error('Durable reopen verification failed');
    const reopenAndReadMs = performance.now() - reopenStart;
    return { mode, initialEvents: size, measuredAppends: rounds, eventsPerAppend: 1, finalEvents: events.length,
      initialBodyBytes: Buffer.byteLength(JSON.stringify(events.slice(0, size))),
      commitMs: { p50: percentile(timings, 0.5), p95: percentile(timings, 0.95), samples: timings },
      eventLoopDelayMs: { p50: delay.percentile(50) / 1e6, p95: delay.percentile(95) / 1e6, max: delay.max / 1e6 },
      indexWrites, addedObjectBytes, versionCount, reopenAndReadMs };
  } finally {
    delay.disable();
    database?.close();
    if (!basename(root).startsWith('dsh-sm11-benchmark-') || await readFile(join(root, '.dsh-synthetic-fixture'), 'utf8') !== 'SM11 benchmark') throw new Error('Synthetic cleanup marker mismatch');
    await rm(root, { recursive: true, force: true });
  }
}
const results = [];
for (const size of sizes) {
  for (const mode of ['full-rebuild', 'incremental']) {
    const result = await measure(mode, size);
    results.push(result);
    process.stderr.write(`${mode}: ${size} initial events, p50 ${result.commitMs.p50.toFixed(2)} ms, p95 ${result.commitMs.p95.toFixed(2)} ms\n`);
  }
}
const report = { schemaVersion: 1, capturedAt: new Date().toISOString(), environment: { node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, logicalCpus: cpus().length },
  notes: ['Synthetic fixtures only; full event-body validation, serialization and compression remain in both modes.',
    'Index writes counted with identical SQLite triggers in both modes; latency includes that instrumentation.',
    'Reopen/read measures durable current-head reading, not full Launcher runtime recovery.',
    'One warmup append excluded; retained bodies are not chunked and physical body bytes need not decrease.'], results };
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify({ output, cases: results.length }) + '\n');
