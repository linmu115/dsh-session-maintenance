import type { PluginDataMappingAdapter, PluginDataRecord, PluginDataTarget } from '@linmu/dsh-session-contracts';
export class PluginDataMappingRegistry {
  private readonly adapters = new Map<string, PluginDataMappingAdapter>();
  register(adapter: PluginDataMappingAdapter): () => void {
    if (this.adapters.has(adapter.namespace)) throw new Error('Duplicate plugin data adapter');
    this.adapters.set(adapter.namespace, adapter);
    return () => { if (this.adapters.get(adapter.namespace) === adapter) this.adapters.delete(adapter.namespace); };
  }
  begin() { return new PluginDataMappingSession(namespace => this.adapters.get(namespace)); }
  async withAccess<T>(targets: readonly PluginDataTarget[], work: () => Promise<T>): Promise<T> {
    let action = work;
    for (const adapter of [...this.adapters.values()].reverse()) if (adapter.withAccess) {
      const next = action; action = () => adapter.withAccess!(targets, next);
    }
    return action();
  }
  async capture(target: PluginDataTarget): Promise<PluginDataRecord[]> {
    const records: PluginDataRecord[] = [];
    for (const adapter of this.adapters.values()) {
      for (const record of await adapter.capture?.(structuredClone(target)) ?? []) {
        if (record.namespace !== adapter.namespace) throw new Error('Plugin capture claimed a foreign namespace');
        records.push(structuredClone(record));
      }
    }
    return records;
  }
}
export class PluginDataMappingSession {
  private readonly checks: (() => Promise<void>)[] = [];
  private restored = 0;
  private retained = 0;
  get counts() { return { restored: this.restored, retained: this.retained }; }
  constructor(private readonly find: (namespace: string) => PluginDataMappingAdapter | undefined) {}
  async map(record: PluginDataRecord, target: PluginDataTarget) {
    const adapter = this.find(record.namespace);
    if (!adapter || !await adapter.handshake(record.dataType)) { this.retained++; return { status: 'retained-only' as const }; }
    const placement = await adapter.restore(structuredClone(record), structuredClone(target));
    const check = async () => {
      if (this.find(record.namespace) !== adapter || !await adapter.handshake(record.dataType)
        || !await adapter.verify(structuredClone(record), structuredClone(placement), structuredClone(target))) throw new Error('Plugin data is not usable after mapping');
    };
    this.checks.push(check);
    this.restored++;
    return { status: 'mapped' as const, placement };
  }
  async verify(): Promise<void> { for (const check of this.checks) await check(); }
}
