import { Context, Service } from '@deepseek-ai/cordis';
import { expect, it, vi } from 'vitest';
import { createLynnAdapter } from '../../../packages/adapter-lynn/src/runtime.js';

it('captures Core and Sticker services through real Cordis context wrappers and fences replaced services', async () => {
  const ctx = new Context();
  const coreStore = { table: {}, options: { profileId: 'web' }, read: () => ({ revision: 1, marker: 'core' }), mutate: async () => {} };
  const stickerStore = { save: async () => {}, acknowledgeBacklinkDelete: async () => {} };
  class Core extends Service {
    store = coreStore;
    constructor(scope: Context) { super(scope, 'annotationCore'); }
  }
  class Stickers extends Service {
    localStore = stickerStore;
    constructor(scope: Context) { super(scope, 'stickerBoard'); }
    readLocalState() { return { document: { sessionId: 'fixture', stickers: [] } }; }
  }
  const adapter = createLynnAdapter(ctx as never);
  const core = ctx.plugin({ name: 'dsh-annotation-core', apply: (scope: Context) => { new Core(scope); } });
  const stickers = ctx.plugin({ name: 'dsh-session-sticker-board', apply: (scope: Context) => { new Stickers(scope); } });
  try {
    await vi.waitFor(async () => {
      expect(await adapter.handshake('core/session')).toBe(true);
      expect(await adapter.handshake('stickers/session')).toBe(true);
    });
    const target = { endpointId: 'fixture', sessionId: 'fixture', context: { profileId: 'web' } };
    expect((await adapter.capture!(target)).map(record => record.dataType)).toEqual(['core/session', 'stickers/session']);
    const packet = (await adapter.capture!(target))[0]!;
    const oldRead = coreStore.read;
    coreStore.read = () => ({ ...oldRead(), restoredGraphReferences: {} });
    await expect(adapter.validate!(packet, target)).resolves.toBeUndefined();
    expect((packet.value as any).payload.restoredGraphReferences).toBeUndefined();
    coreStore.read = () => ({ ...oldRead(), restoredGraphReferences: { reference: { marker: 'new data' } } });
    await expect(adapter.validate!(packet, target)).rejects.toThrow('LYNN_CHANGED_DURING_SYNC');
    coreStore.read = oldRead;
    await adapter.withAccess!([target], async () => {});
    await core.dispose();
    await vi.waitFor(async () => expect(await adapter.handshake('core/session')).toBe(false));
    expect(await adapter.handshake('stickers/session')).toBe(true);
    await stickers.dispose();
    expect(await adapter.handshake('stickers/session')).toBe(false);
  } finally { await core.dispose(); await stickers.dispose(); await ctx.fiber.dispose(); }
});
