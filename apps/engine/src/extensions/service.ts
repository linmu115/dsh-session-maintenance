import { ExtensionDataError, extensionConnectSchema, extensionWriteSchema, extensionScopeSchema,
  type ExtensionDataAdapter, type ExtensionScope, type ExtensionConnect, type ExtensionWrite, type ExtensionPanel, type ExtensionList,
} from "@linmu/dsh-session-contracts";
import type { SqliteExtensionRepository } from "@linmu/dsh-session-store";

/** Independent from the platform/version adapter registry. No automatic context injection. */
export class ExtensionDataService {
  private readonly adapters = new Map<string, ExtensionDataAdapter>();
  constructor(private readonly store: SqliteExtensionRepository, adapters: readonly ExtensionDataAdapter[]) {
    for (const adapter of adapters) this.register(adapter);
  }
  /** Trusted Engine-side installation; unregistering never deletes stored data. */
  register(adapter: ExtensionDataAdapter): () => void {
    extensionScopeSchema.parse({instanceId:"registration",profileId:"registration",namespace:adapter.namespace});
    if (this.adapters.has(adapter.namespace)) throw new Error("Duplicate extension adapter namespace");
    this.adapters.set(adapter.namespace,adapter);
    return () => { if (this.adapters.get(adapter.namespace)===adapter)this.adapters.delete(adapter.namespace); };
  }
  panels(): ExtensionPanel[] {
    return this.store.connections().map(row => {
      const adapter = this.adapters.get(row.namespace);
      return { scope: { instanceId: row.instance_id, profileId: row.profile_id, namespace: row.namespace },
        label: adapter?.label ?? row.namespace, pluginVersion: row.plugin_version, writerId: row.writer_id,
        configured: row.configured===1, enabled: row.enabled===1,
        status: !adapter ? "missing-adapter" : !row.configured || !row.enabled ? "disabled"
          : !adapter.pluginVersions.includes(row.plugin_version) ? "incompatible" : "ready",
        objectCount: row.object_count, conflictCount: row.conflict_count, bytes: row.bytes, capabilities: adapter?.capabilities ?? null };
    });
  }
  connect(input: ExtensionConnect) {
    const parsed = extensionConnectSchema.parse(input);
    if (new Set(parsed.plugins.map(p=>p.namespace)).size !== parsed.plugins.length) throw new ExtensionDataError("EXTENSION_DUPLICATE", "同一数据域只能配置一个写入方。",400);
    this.store.connect(parsed); return this.panels();
  }
  enable(scope: ExtensionScope, enabled: boolean) { this.store.enable(extensionScopeSchema.parse(scope),enabled); return this.panels(); }
  list(query: ExtensionList) { return this.store.list(query); }
  private ready(scope: ExtensionScope): { adapter: ExtensionDataAdapter; panel: ExtensionPanel } {
    extensionScopeSchema.parse(scope);
    const panel = this.panels().find(p=>p.scope.instanceId===scope.instanceId&&p.scope.profileId===scope.profileId&&p.scope.namespace===scope.namespace);
    if (panel?.status !== "ready") throw new ExtensionDataError("EXTENSION_UNAVAILABLE", "此实例尚未启用兼容的扩展；保存的数据仍然保留。");
    return { adapter: this.adapters.get(scope.namespace)!, panel };
  }
  get(scope: ExtensionScope, objectId: string) {
    const { adapter } = this.ready(scope);
    if (!adapter.capabilities.read) throw new ExtensionDataError("EXTENSION_READ_UNAVAILABLE", "此扩展未提供正文读取能力。");
    const object = this.store.get(scope,objectId);
    if (!object) throw new ExtensionDataError("EXTENSION_NOT_FOUND", "扩展对象不存在。",404);
    if (!adapter.schemaVersions.includes(object.schemaVersion)) throw new ExtensionDataError("EXTENSION_SCHEMA_UNSUPPORTED", "需要兼容此对象格式的适配器。");
    return { object, summary: adapter.summarize(object.content.body), conflictIds: this.store.conflictIds(scope,objectId),
      ...(adapter.preview?{preview:adapter.preview(object.content.body)}:{}) };
  }
  write(input: ExtensionWrite) {
    const parsed = extensionWriteSchema.parse(input);
    const { adapter, panel } = this.ready(parsed.scope);
    const current = this.store.get(parsed.scope,parsed.objectId);
    if (!adapter.capabilities.write || (parsed.deleted && !adapter.capabilities.delete) || (current?.deleted && !parsed.deleted && !adapter.capabilities.restore)) {
      throw new ExtensionDataError("EXTENSION_WRITE_UNAVAILABLE", "此扩展未提供所请求的写入能力。");
    }
    if (panel.writerId !== parsed.writerId) throw new ExtensionDataError("EXTENSION_WRITER_CONFLICT", "写入方与已登记的数据归属不匹配。");
    if (!adapter.schemaVersions.includes(parsed.content.schemaVersion)) throw new ExtensionDataError("EXTENSION_SCHEMA_UNSUPPORTED", "扩展对象格式暂不兼容。");
    adapter.validate(parsed.content);
    return this.store.write(parsed);
  }
  conflict(scope: ExtensionScope, conflictId: string) {
    this.ready(scope);
    const conflict = this.store.getConflict(scope,conflictId);
    if (!conflict) throw new ExtensionDataError("EXTENSION_NOT_FOUND", "冲突已处理或不存在。",404);
    return conflict;
  }
  resolve(scope: ExtensionScope, conflictId: string, revision: number, choice: "current" | "incoming") {
    const conflict = this.conflict(scope,conflictId);
    return this.store.transaction(() => {
      const current = this.store.get(scope,conflict.objectId)!;
      if (current.revision !== revision) throw new ExtensionDataError("EXTENSION_REVISION_CONFLICT", "对象再次发生变化，请重新检查冲突。");
      const result = choice === "current" ? { status: "unchanged" as const, object: current }
        : this.write({ ...conflict.incoming, expectedRevision: revision });
      if (result.status === "conflict") throw new ExtensionDataError("EXTENSION_REVISION_CONFLICT", "对象已变化，请重试。");
      this.store.removeConflict(scope,conflictId);
      return { ...result, object: this.store.get(scope,conflict.objectId)! };
    });
  }
}
