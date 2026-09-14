import { describe, expect, it, vi } from 'vitest';
import { rc2ProjectionContext, bindRc2ProjectionContext, rc2RuntimeHeader } from '../src/rc2-persistence.js';
import { validateV3 } from '../../../packages/adapter-dsh-0-1-5/src/official.js';
import { installRc2LazyProjectionPersistence } from '../src/rc2-lazy-persistence.js';

const header = { version: 3, id: 'cold-session', createdAt: 1, isSeeded: false, delegationDepth: 0 };

it('normalizes a live ordinary header before strict V3 registration and durable roundtrip', () => {
  const { delegationDepth: _depth, ...live } = header;
  expect(() => validateV3({ header: live, events: [], inheritedEventCount: 0 } as never)).toThrow('delegationDepth');
  const normalized = rc2RuntimeHeader(live as never);
  expect(normalized.delegationDepth).toBe(0);
  expect(live).not.toHaveProperty('delegationDepth');
  expect(validateV3({ header: normalized, events: [], inheritedEventCount: 0 } as never).header).toEqual(header);
  expect(rc2RuntimeHeader({ ...header, delegationDepth: 2 } as never).delegationDepth).toBe(2);
  for (const depth of [-1, NaN, null, '0']) expect(() => rc2RuntimeHeader({ ...header, delegationDepth: depth } as never)).toThrow();
});

describe('RC2 projection storage boundary', () => {
  it('holds one writer, preserves header/cut options, flushes empty history, and closes before handoff', async () => {
    const sequence: string[] = [];
    const writer = { append: vi.fn(async () => { sequence.push('append'); }),
      flush: vi.fn(async () => { sequence.push('flush'); }), close: vi.fn(async () => { sequence.push('close'); }) };
    const create = vi.fn(async () => { sequence.push('create'); return writer; });
    const context = rc2ProjectionContext({ sessionPersistence: { create, list: async () => [{ header, revision: 'r' }] },
      workspaceRegistry: {}, sessionProjectionCache: {} } as never);
    await context.sessionPersistence.create(header);
    expect(create).toHaveBeenCalledWith(header, {});
    await expect(context.sessionPersistence.create(header)).rejects.toThrow('already started');
    await context.sessionPersistence.finishHydration!(header.id);
    expect(sequence).toEqual(['create', 'flush', 'close']);
    await expect(context.sessionPersistence.list()).resolves.toEqual([header]);
    await expect(context.sessionPersistence.append(header.id, [{}])).rejects.toThrow('not owned');
  });

  it('closes failed writers and refuses a retry against incomplete history', async () => {
    const close = vi.fn(async () => {});
    const writer = { append: async () => {}, flush: async () => { throw new Error('disk full'); }, close };
    const context = rc2ProjectionContext({ sessionPersistence: { create: async () => writer }, workspaceRegistry: {}, sessionProjectionCache: {} } as never);
    await context.sessionPersistence.create(header);
    await expect(context.sessionPersistence.finishHydration!(header.id)).rejects.toThrow('disk full');
    expect(close).toHaveBeenCalledOnce();
    await expect(context.sessionPersistence.create(header)).rejects.toThrow('already started');
    await context.sessionPersistence.closeHydrationHandles!();
    expect(close).toHaveBeenCalledOnce();
  });

  it('lists and stats cold snapshots without materializing; concurrent opens hydrate once and restore descriptors', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let cold = true;
    const hydrate = vi.fn(async () => { await gate; cold = false; });
    const open = vi.fn(async () => 'opened');
    const native = { header: { ...header, id: 'hot-session' }, revision: 'native' };
    const persistence = { open, list: vi.fn(async () => [native]), stat: vi.fn(async () => native) };
    const restore = installRc2LazyProjectionPersistence(persistence as never, {
      sessionHeaders: () => [header], coldSessionIds: () => cold ? [header.id] : [], hydrate,
    } as never);
    expect((await persistence.list()).map(row => row.header.id)).toEqual(['cold-session', 'hot-session']);
    expect(await (persistence.stat as Function)(header.id)).toMatchObject({ header });
    expect(hydrate).not.toHaveBeenCalled();
    const first = (persistence.open as Function)(header.id, 'read');
    const second = (persistence.open as Function)(header.id, 'write');
    expect(open).not.toHaveBeenCalled();
    release();
    expect(await Promise.all([first, second])).toEqual(['opened', 'opened']);
    expect(hydrate).toHaveBeenCalledOnce();
    restore(); expect(persistence.open).toBe(open);
  });

  it('never hands an incomplete stream to the official open and aborts an in-flight open on detach', async () => {
    const open = vi.fn();
    const persistence = { open, list: async () => [], stat: vi.fn() };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const restore = installRc2LazyProjectionPersistence(persistence as never, {
      sessionHeaders: () => [header], coldSessionIds: () => [header.id], hydrate: () => gate,
    } as never);
    const pending = (persistence.open as Function)(header.id, 'read');
    restore(); release();
    await expect(pending).rejects.toThrow('detached during hydration');
    expect(open).not.toHaveBeenCalled();
  });
});


it('borrows the already-open host cache without opening or closing it', async () => {
  const table = {};
  const domain = { name: 'session_projcache', table: () => table, close: vi.fn(async () => { throw new Error('host owner only'); }) };
  const open = vi.fn(async () => { throw new Error('already-open'); });
  const ctx = { storageDomain: { get: () => domain, open }, workspaceRegistry: { replaceHeaderIndex() {} }, sessionPersistence: {}, sessionProjectionCache: {} };
  const binding = await bindRc2ProjectionContext(ctx as never);
  await binding.dispose();
  expect(open).not.toHaveBeenCalled();
  expect(domain.close).not.toHaveBeenCalled();
  await expect(bindRc2ProjectionContext({ ...ctx, storageDomain: { get: () => undefined } } as never)).rejects.toThrow('not initialized');
});
