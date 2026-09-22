import { isDeepStrictEqual } from 'node:util';
import type { PluginDataMappingAdapter, JsonValue } from '@linmu/dsh-session-contracts';
import { PLUGIN_EVENTS, validatePluginEvent } from './codec.js';

/** Runtime handshake belongs to GPT's adapter, independently of Lynn and host identity. */
export function createGptMappingAdapter(input: {
  runtime: { registry: { values(): Iterable<{ name?: string; fibers: Iterable<{ state: number }> }> } };
  readSession(id: string): Promise<{ events: readonly unknown[] }>;
}): PluginDataMappingAdapter {
  const alive = () => [...input.runtime.registry.values()].some(runtime => runtime.name === 'dsh-gpt-compat' && [...runtime.fibers].some(fiber => fiber.state === 2));
  return { namespace: 'gpt-compat', handshake: async type => PLUGIN_EVENTS.has(type) && alive(),
    restore: async record => {
      const event = record.value as unknown as Parameters<typeof validatePluginEvent>[0];
      if (event.type !== record.dataType || !PLUGIN_EVENTS.has(event.type)) throw new Error('GPT mapping event ownership differs');
      validatePluginEvent(event);
      return { kind: 'host-event', value: structuredClone(record.value) };
    },
    verify: async (_record, placement, target) => {
      if (placement.kind !== 'host-event') return false;
      const expected = placement.value as { seq: number } & Record<string, JsonValue>;
      const snapshot = await input.readSession(target.sessionId);
      return isDeepStrictEqual(snapshot.events[expected.seq], placement.value);
    },
  };
}
