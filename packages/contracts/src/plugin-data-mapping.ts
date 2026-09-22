import type { JsonValue } from './model.js';
/** Maintenance stores provenance and opaque data; it owns no plugin business model. */
export interface PluginDataRecord { readonly namespace: string; readonly dataType: string; readonly recordId: string; readonly value: JsonValue }
/** Opaque endpoint identity and adapter-supplied context; core assigns no meaning to host fields. */
export interface PluginDataTarget { readonly endpointId: string; readonly sessionId: string; readonly context: JsonValue }
export type PluginDataPlacement = { readonly kind: 'host-event'; readonly value: JsonValue }
  | { readonly kind: 'plugin-storage'; readonly receiptId: string };
export interface PluginDataMappingAdapter {
  readonly namespace: string;
  /** The adapter talks to its own live plugin. Configuration alone is not a handshake. */
  handshake(dataType: string): Promise<boolean>;
  /** Idempotent by target + recordId. The adapter chooses where its plugin consumes the data. */
  restore(record: PluginDataRecord, target: PluginDataTarget): Promise<PluginDataPlacement>;
  /** Read through the plugin's normal reader after host persistence completes. */
  verify(record: PluginDataRecord, placement: PluginDataPlacement, target: PluginDataTarget): Promise<boolean>;
}
