import { Context, Service } from '@deepseek-ai/cordis';
import { HostWriteBarrier } from '@linmu/dsh-instance-integration-dsh/host-write-barrier';
import { expect, it } from 'vitest';
it('preserves the calling Cordis scope when instrumenting a shared agent service', async () => {
  const ctx = new Context();
  const seen: unknown[] = [];
  class Agents extends Service {
    constructor(ctx: Context) { super(ctx, 'agents' as never); }
    async create() { seen.push(this.ctx.fiber); return {}; }
    async resume() { return this.create(); }
  }
  await ctx.plugin(Agents);
  let caller: Context | undefined;
  await ctx.plugin((scope: Context) => { caller = scope; });
  const runtime = { agents: ctx.get('agents' as never) as any,
    sessions: { get: () => undefined, prepare: () => {}, enter: () => {}, flush: async () => true },
    sessionPersistence: { open: async () => ({}), create: async () => ({}) } };
  const barrier = new HostWriteBarrier(runtime);
  try {
    await (caller!.get('agents' as never) as any).create();
    expect(seen.length).toBe(1); expect(seen[0] === caller!.fiber).toBe(true);
  } finally { barrier.dispose(); await ctx.fiber.dispose(); }
});
