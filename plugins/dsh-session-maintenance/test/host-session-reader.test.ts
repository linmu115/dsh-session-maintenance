import { Context } from '@deepseek-ai/cordis';
import { SessionId, SessionLogOffset, SessionStore } from '@deepseek-ai/dsh-session';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readHostSession, refreshHostSession } from '../src/host-session-reader.js';

it('reads a real RC2 seeded log with a continued tail without rewriting or losing its inheritance boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'SYNTHETIC-host-observation-'));
  const ctx = new Context();
  try {
    await ctx.plugin(SessionStore);
    await ctx.plugin(JsonlPersistence, { root });
    const query = new SessionQueryEngine(ctx);
    const id = SessionId('seeded-continued');
    const header = { version: 3 as const, id, createdAt: 1, cwd: root, isSeeded: true };
    const events = [{ seq: 0, time: 1, type: 'permission/preset', data: { preset: 'default' } },
      { seq: 1, time: 2, type: 'session/end-seed', data: { inherited: true } },
      { seq: 2, time: 3, type: 'permission/preset', data: { preset: 'default' } }];
    const handle = await ctx.sessionPersistence.create(header, { inheritedEventCount: SessionLogOffset(1) });
    await handle.append(events as never); await handle.flush(); await handle.close();
    await expect(query.readSession(id)).rejects.toThrow('seeded session constructor seed');
    const before = await ctx.sessionPersistence.stat(id);
    const read = await readHostSession(query, id);
    expect(read.inheritedEventCount).toBe(1);
    expect(read.events).toEqual(events);
    expect(read.session.isSeeded).toBe(true);
    expect(await ctx.sessionPersistence.stat(id)).toEqual(before);
    expect(ctx.sessions.get(id)).toBeUndefined();
    let hydrated = false, persisted = false;
    await refreshHostSession(query, {
      hydratePrepared(session, history) { expect(session.inheritedEventCount).toBe(1); expect(history).toEqual(events); hydrated = true; return {} as never; },
      async write(session) { expect(hydrated).toBe(true); expect(session.id).toBe(id); await Promise.resolve(); persisted = true; },
    }, id);
    expect(persisted).toBe(true);
    expect(await ctx.sessionPersistence.stat(id)).toEqual(before);
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});

it('releases the observation even if its lazy event read fails', async () => {
  let disposed = 0;
  const query = { observeSession: async () => ({ header: {}, inheritedEventCount: 0,
    get events(): never { throw new Error('read failed'); }, [Symbol.dispose]() { disposed++; } }) };
  await expect(readHostSession(query as never, 'synthetic')).rejects.toThrow('read failed');
  expect(disposed).toBe(1);
});
