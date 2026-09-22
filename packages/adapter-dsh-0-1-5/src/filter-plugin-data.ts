import type { JsonValue } from '@linmu/dsh-session-contracts';
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format';
import { remap } from './references-remap.js';
import { digest, record } from './common.js';
/** Native sequence/reference reconstruction belongs to the format adapter. */
export async function filterNativePluginData(payload: JsonValue, map: (event: SessionFormatEvent) => Promise<SessionFormatEvent | null>): Promise<JsonValue> {
  const source = record(payload), events = source.events as unknown as SessionFormatEvent[];
  const selected = await Promise.all(events.map(event => map(structuredClone(event))));
  const mapping: (number | undefined)[] = []; let count = 0;
  selected.forEach((event, index) => { if (event) mapping[events[index]!.seq] = count++; });
  if (selected.every((event, index) => event !== null && digest(event) === digest(events[index]))) return payload;
  const filtered = selected.flatMap((event, index) => event === null ? [] : [Object.assign(event, remap(event, mapping[events[index]!.seq]!, mapping))]);
  const inherited = Number(source.inheritedEventCount ?? 0);
  const ledger = source.conversionLedger === undefined ? {} : record(source.conversionLedger);
  return { ...source, events: filtered, inheritedEventCount: selected.slice(0, inherited).filter(Boolean).length,
    pluginProjection: { nativeToSource: selected.flatMap((event, index) => event ? [events[index]!.seq] : []), sourceNativeCount: events.length },
    conversionLedger: { ...ledger, eventsDigest: digest(filtered), nativeRevision: filtered.length } } as unknown as JsonValue;
}
export function remapProjectedAppend(event: JsonValue, seq: number, mapping: readonly (number | undefined)[]): JsonValue {
  return remap(event as unknown as SessionFormatEvent, seq, mapping) as unknown as JsonValue;
}
