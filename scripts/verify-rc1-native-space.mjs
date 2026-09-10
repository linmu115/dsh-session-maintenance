// Uses official RC1 code, but only synthetic sessions in a marked temporary directory.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rc1NativeSessionCodec as codec } from '../packages/adapter-dsh-rc1/dist/index.js';
const official = realpathSync(process.env.DSH_OFFICIAL_ROOT);
function modulePath(name) {
  const store = join(official, 'node_modules/.pnpm');
  const matches = [...new Set(readdirSync(store).map(d => join(store, d, 'node_modules', name, 'package.json'))
    .filter(existsSync).map(path => realpathSync(path)))];
  assert.equal(matches.length, 1, `ambiguous official module ${name}`);
  return pathToFileURL(createRequire(matches[0]).resolve(name));
}
const { Context } = await import(modulePath('@deepseek-ai/cordis'));
const { SessionStore } = await import(modulePath('@deepseek-ai/dsh-session'));
const { default: Persistence } = await import(modulePath('@deepseek-ai/dsh-session-persistence-jsonl'));
const fixture = await mkdtemp(join(tmpdir(), 'dsh-native-official-synthetic-'));
await writeFile(join(fixture, '.synthetic-fixture'), 'No real session data.');
const root = join(fixture, 'sessions');
const expected = new Map();
let ctx;
try {
  for (let i = 0; i < 205; i++) {
    const id = `synthetic-${i}`;
    const events = i === 0 ? [] : [{ type: 'user/message', seq: 0, time: 2,
      data: { id: `message-${i}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `synthetic cold history ${i}` }] }, surfaceOp: 'append' }];
    const payload = { header: { version: 0, id, cwd: fixture, createdAt: 1, delegationDepth: 0, isSeeded: i === 204,
      ...(i === 204 ? { parentSession: 'synthetic-203' } : {}) }, inheritedEventCount: i === 204 ? 1 : 0, events };
    const description = await codec.describe(payload, root);
    const file = join(root, description.relativePath);
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, codec.encode(payload, description));
    expected.set(id, { file, mtime: (await stat(file, { bigint: true })).mtimeNs, events });
  }
  // Reopening a fresh official persistence object proves no Maintenance hydration is needed.
  for (let pass = 0; pass < 2; pass++) {
    ctx = new Context(); new SessionStore(ctx);
    const persistence = new Persistence(ctx, { root, compression: 'zstd' });
    assert.equal((await persistence.list()).length, 205);
    for (const id of ['synthetic-0', 'synthetic-203', 'synthetic-204']) {
      const result = await persistence.readFrom(id, 0);
      assert.deepEqual(result.events, expected.get(id).events);
      assert.equal((await stat(expected.get(id).file, { bigint: true })).mtimeNs, expected.get(id).mtime);
    }
    await ctx.fiber.dispose(); ctx = undefined;
  }
  console.log(JSON.stringify({ officialVersion: '0.1.2-rc.1', sessions: 205, coldRead: true,
    emptyRead: true, seededRead: true, reopenedRead: true, originalMtimeUnchanged: true, fixtureOnly: true }));
} finally { await ctx?.fiber.dispose(); await rm(fixture, { recursive: true, force: true }); }
