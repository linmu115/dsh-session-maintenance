import { expect, it } from 'vitest';
import { PluginMutationGate } from '../src/mutation-gate.js';
it('drains prior writes, rejects new affected writes, and releases only after successful recovery', async () => {
  let finish!: () => void, entered = false;
  const service = { write: async (_id: string) => { await new Promise<void>(resolve => { finish = resolve; }); } };
  const gate = new PluginMutationGate(), dispose = gate.instrument(service, 'write');
  const pending = service.write('target'); await Promise.resolve();
  const recovery = gate.exclusive(['target'], async () => { entered = true; throw new Error('reader failed'); });
  expect(entered).toBe(false); await expect(service.write('target')).rejects.toThrow('LYNN_BUSY');
  finish(); await pending; await expect(recovery).rejects.toThrow('reader failed');
  await expect(service.write('target')).rejects.toThrow('LYNN_BUSY');
  await gate.exclusive(['target'], async () => {});
  const next = service.write('target'); await Promise.resolve(); finish(); await next; dispose();
});
