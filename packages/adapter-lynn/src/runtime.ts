import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { JsonValue, PluginDataMappingAdapter, PluginDataRecord, PluginDataTarget } from '@linmu/dsh-session-contracts';
import { PluginMutationGate } from './mutation-gate.js';

export const LYNN_ADAPTER = { id: 'lynn', label: 'Lynn adapter', version: '0.1.0' } as const;
export interface LynnHost {
  get(name: string): any;
  registry: { values(): Iterable<{ name?: string; fibers: Iterable<{ state: number }> }> };
  inject?(services: string[], callback: (scope: LynnHost) => void): unknown;
  effect?(callback: () => (() => void), label: string): unknown;
}
const live = (host: LynnHost, name: string) => [...host.registry.values()].some(runtime => runtime.name === name && [...runtime.fibers].some(fiber => fiber.state === 2));
const obj = (value: any): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Lynn: invalid plugin snapshot'); return value;
};
const sessionFields = new Set(['sessionId', 'nativeSessionId', 'sourceNativeSessionId', 'targetNativeSessionId', 'ownerSessionId', 'sourceSessionId', 'targetSessionId']);
/** Only plugin-defined identity fields are rewritten. User text and unknown structure remain untouched. */
function relocate(value: any, source: any, target: PluginDataTarget, nativeLogicalIds = false): any {
  const context = obj(target.context), identities = new Map<string, string>([[source.sessionId, target.sessionId]]);
  for (const identity of context.identities ?? []) if (identity.endpointId === source.endpointId) identities.set(identity.sourceSessionId, identity.targetSessionId);
  // A derived session may share source provenance with its parent. Its own identity wins.
  identities.set(source.sessionId, target.sessionId);
  const visit = (item: any, key = ''): any => {
    if (Array.isArray(item)) return item.map(child => visit(child));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([name, child]) => [name, visit(child, name)]));
    if (typeof item === 'string' && (sessionFields.has(key) || nativeLogicalIds && key === 'logicalSessionId')) {
      if (!item) return item;
      if (identities.has(item)) return identities.get(item);
      if (source.endpointId !== target.endpointId) throw new Error(`Lynn: unresolved cross-session identity (${key})`);
    }
    if (key === 'profileId' && item === source.profileId) return context.profileId ?? item;
    return item;
  };
  return visit(structuredClone(value));
}
const record = (type: string, target: PluginDataTarget, payload: unknown): PluginDataRecord => ({ namespace: 'lynn', dataType: type, recordId: type,
  value: { origin: { endpointId: target.endpointId, sessionId: target.sessionId, profileId: obj(target.context).profileId ?? 'web' }, payload } as JsonValue });

/** All knowledge of Core / DAG / Sticker storage is local to this combined adapter. */
export function createLynnAdapter(host: LynnHost): PluginDataMappingAdapter {
  const gate = new PluginMutationGate();
  const guarded = new Map<string, object>();
  const hooks: [string, (service: any) => [any, string][]][] = [
    ['annotationCore', service => [[service.store, 'mutate']]],
    ['sessionExtensionData', service => [[service, 'write'], [service, 'ready']]],
    ['stickerBoard', service => [[service.localStore, 'save'], [service.localStore, 'acknowledgeBacklinkDelete']]],
  ];
  for (const [name, ports] of hooks) host.inject?.([name], scope => {
    const disposers = ports(scope.get(name)).filter(([target, method]) => typeof target?.[method] === 'function').map(([target, method]) => gate.instrument(target, method));
    const service = scope.get(name);
    if (disposers.length === ports(service).length) guarded.set(name, service);
    scope.effect?.(() => () => { if (guarded.get(name) === service) guarded.delete(name); for (const dispose of disposers.reverse()) dispose(); }, 'Lynn plugin mutation gate');
  });
  const available = (type: string) => {
    if (type === 'core/session') return guarded.get('annotationCore') === host.get('annotationCore') && live(host, 'dsh-annotation-core') && !!host.get('annotationCore')?.store?.table;
    if (type === 'core/extensions') return guarded.get('sessionExtensionData') === host.get('sessionExtensionData') && live(host, 'dsh-annotation-core') && host.get('sessionExtensionData')?.protocolVersion === 1;
    if (type === 'dag/extensions') return guarded.get('sessionExtensionData') === host.get('sessionExtensionData') && live(host, 'thoughtdag') && host.get('sessionExtensionData')?.protocolVersion === 1;
    if (type === 'stickers/session') return guarded.get('stickerBoard') === host.get('stickerBoard') && live(host, 'dsh-session-sticker-board') && !!host.get('stickerBoard')?.localStore;
    return false;
  };
  const readNative = async (type: string, target: PluginDataTarget) => {
    if (type === 'core/session') {
      const store = host.get('annotationCore').store;
      return store.read(target.sessionId);
    }
    if (type === 'stickers/session') return host.get('stickerBoard').readLocalState(target.sessionId);
    const data = host.get('sessionExtensionData'), namespaces = type === 'dag/extensions' ? ['thoughtdag'] : ['annotation-upstream', 'annotation-context'];
    return namespaces.flatMap(namespace => data.list(namespace, target.sessionId)).sort((a: any, b: any) => JSON.stringify([a.namespace, a.objectId]).localeCompare(JSON.stringify([b.namespace, b.objectId])));
  };
  const read = async (type: string, target: PluginDataTarget) => JSON.parse(JSON.stringify(await readNative(type, target)));
  const mapped = (item: PluginDataRecord, target: PluginDataTarget) => {
    const envelope = obj(item.value), origin = obj(envelope.origin);
    const destination = item.dataType === 'core/session' ? { ...target, context: { ...obj(target.context), profileId: host.get('annotationCore').store.options.profileId } } : target;
    const source = item.dataType === 'core/session' && envelope.payload ? { ...origin, profileId: envelope.payload.profileId } : origin;
    const value = relocate(envelope.payload, source, destination, item.dataType === 'dag/extensions');
    if (item.dataType.endsWith('/extensions')) for (const row of value) {
      if (row.namespace === 'thoughtdag') {
        row.objectId = `graph-${createHash('sha256').update(target.sessionId).digest('hex')}`;
        const graph = row.content?.graph;
        if (graph) {
          const nodes = new Map<string, string>();
          for (const node of graph.nodes) if (node.data?.kind === 'session' && node.id.startsWith('session:')) {
            const next = `session:${node.data.logicalSessionId}`; nodes.set(node.id, next); node.id = next;
          }
          for (const edge of graph.edges) {
            const automatic = edge.id === `bound:${edge.source}:${edge.target}`;
            edge.source = nodes.get(edge.source) ?? edge.source; edge.target = nodes.get(edge.target) ?? edge.target;
            if (automatic) edge.id = `bound:${edge.source}:${edge.target}`;
          }
        }
      }
    }
    if (item.dataType === 'stickers/session') {
      const document = value.document;
      document.revision = `sha256:${createHash('sha256').update(JSON.stringify({ sessionId: document.sessionId, stickers: document.stickers,
        ...(document.vaultId ? { vaultId: document.vaultId } : {}) })).digest('hex')}`;
    }
    return value;
  };
  return {
    namespace: 'lynn', handshake: async type => available(type),
    withAccess: (targets, work) => gate.exclusive(targets.map(target => target.sessionId), async () => {
      // Include writes admitted before this adapter was loaded, not only intercepted calls.
      const core = host.get('annotationCore')?.store, stickers = host.get('stickerBoard')?.localStore;
      await Promise.all(targets.flatMap(target => [core?.tails?.get(`${core.options.profileId}:${target.sessionId}`), stickers?.mutations?.get(target.sessionId)]));
      await host.get('sessionExtensionData')?.drain?.();
      return work();
    }),
    capture: async target => {
      const collect = async () => {
      const rows: PluginDataRecord[] = [];
      for (const type of ['core/session', 'core/extensions', 'dag/extensions', 'stickers/session']) if (available(type)) rows.push(record(type, target, await read(type, target)));
      // Unknown extension namespaces remain opaque, with no destination write capability.
      const data = host.get('sessionExtensionData');
      if (data?.protocolVersion === 1 && data.table?.entries) {
        const known = new Set(['annotation-upstream', 'annotation-context', 'thoughtdag']);
        const unknown = new Map<string, unknown[]>();
        for (const [, row] of data.table.entries()) if (row.sessionId === target.sessionId && !known.has(row.namespace)) {
          const group = unknown.get(row.namespace) ?? []; group.push(structuredClone(row)); unknown.set(row.namespace, group);
        }
        for (const [namespace, payload] of unknown) rows.push(record(`opaque-extension/${namespace}`, target, payload));
      }
      return rows;
      };
      let previous = await collect();
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await collect();
        if (JSON.stringify(previous) === JSON.stringify(current)) return current;
        previous = current;
      }
      throw new Error('LYNN_CAPTURE_BUSY: plugin data is changing; retry capture');
    },
    restore: async (item, target) => {
      const value = mapped(item, target);
      const envelope = obj(item.value), origin = obj(envelope.origin);
      if (origin.endpointId === target.endpointId && origin.sessionId === target.sessionId) {
        const current = await read(item.dataType, target);
        if (!isDeepStrictEqual(current, envelope.payload) && !isDeepStrictEqual(current, value))
          throw new Error('LYNN_CHANGED_DURING_SYNC: plugin data changed since capture');
      }
      if (item.dataType === 'core/session') {
        const store = host.get('annotationCore').store, key = `${store.options.profileId}:${target.sessionId}`;
        if (value === null) await store.table.delete(key); else if (store.table.get(key)) await store.table.update(key, () => value); else await store.table.put(key, value);
      } else if (item.dataType === 'stickers/session') {
        const store = host.get('stickerBoard').localStore;
        if (await store.ownership(target.sessionId)) throw new Error('Lynn: sticker ownership must be reconciled before restoring');
        await store.serialized(target.sessionId, () => store.write(target.sessionId, value));
      } else {
        const data = host.get('sessionExtensionData'), namespaces = item.dataType === 'dag/extensions' ? ['thoughtdag'] : ['annotation-upstream', 'annotation-context'];
        const table = data.table;
        if (!table || value.some((row: any) => row.sessionId !== target.sessionId || !namespaces.includes(row.namespace))) throw new Error('Lynn: invalid extension target');
        for (const namespace of namespaces) for (const old of data.list(namespace, target.sessionId)) {
          if (!value.some((row: any) => row.namespace === namespace && row.objectId === old.objectId)) await table.delete(JSON.stringify([target.sessionId, namespace, old.objectId]));
        }
        for (const row of value) { const key = JSON.stringify([target.sessionId, row.namespace, row.objectId]);
          if (table.get(key)) await table.update(key, () => row); else await table.put(key, row);
        }
      }
      return { kind: 'plugin-storage', receiptId: item.recordId };
    },
    verify: async (item, _placement, target) => isDeepStrictEqual(await read(item.dataType, target), mapped(item, target)),
  };
}
