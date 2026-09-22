import { expect, it } from 'vitest';
import { createGptMappingAdapter, filterNativePluginData, remapProjectedAppend } from '../src/index.js';
import { PluginDataMappingRegistry } from '../../adapter-host/src/plugin-data-mapping.js';
it('handshakes with the live plugin, remaps checkpoints and verifies the normal reader without changing source bytes', async () => {
  let active = true, events: any[] = [];
  const registry = new PluginDataMappingRegistry(); registry.register(createGptMappingAdapter({
    runtime: { registry: { values: () => [{ name: 'dsh-gpt-compat', fibers: [{ state: active ? 2 : 4 }] }] } },
    readSession: async () => ({ events }),
  }));
  const payload = { events: [{ seq: 0, time: 1, type: 'future/unknown', data: {} },
    { seq: 1, time: 2, type: 'context/checkpoint', data: { key: 'gpt', state: { encrypted_content: 'synthetic' } } },
    { seq: 2, time: 3, type: 'context/checkpoint-commit', data: { checkpoint: 1 } }], inheritedEventCount: 2 };
  const original = JSON.stringify(payload), pass = registry.begin();
  const result = await filterNativePluginData(payload, async event => {
    if (event.type === 'future/unknown') return null;
    const mapped = await pass.map({ namespace: 'gpt-compat', dataType: event.type, recordId: String(event.seq), value: event as any }, { endpointId: 'test', sessionId: 'session', context: {} });
    return mapped.status === 'mapped' && mapped.placement.kind === 'host-event' ? mapped.placement.value as any : null;
  }) as any;
  events = structuredClone(result.events); expect(events[1].data.checkpoint).toBe(0); expect(result.inheritedEventCount).toBe(1);
  await pass.verify(); expect(JSON.stringify(payload)).toBe(original);
  expect((remapProjectedAppend(events[1], 3, [2, 3]) as any).data.checkpoint).toBe(2);
  events[0].data.state = { corrupted: true }; await expect(pass.verify()).rejects.toThrow('not usable');
  active = false; const missing = registry.begin();
  expect((await missing.map({ namespace: 'gpt-compat', dataType: payload.events[1]!.type, recordId: '1', value: payload.events[1]! }, { endpointId: 'test', sessionId: 'session', context: {} })).status).toBe('retained-only');
});
it('rejects dangling plugin coordinates instead of producing a readable-looking corrupt checkpoint', () => {
  expect(() => remapProjectedAppend({ seq: 4, type: 'context/operation-result', time: 1, data: { operation: 2, output: {} } }, 1, [0, undefined, undefined])).toThrow('absent');
});
