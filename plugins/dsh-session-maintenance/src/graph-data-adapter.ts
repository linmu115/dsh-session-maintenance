import { createHash } from 'node:crypto';
import { managedGraphSchema, type SessionExtensionSync, type SessionExtensionReplicaObject, type GraphSessionIdentity, type GraphResolve, type JsonValue, type ExtensionObject } from '@linmu/dsh-session-contracts';
import type { MaintenanceExtensionBridge } from './extension-data.js';

const namespace = 'thoughtdag';
const graphId = (id: string) => `graph-${createHash('sha256').update(id).digest('hex')}`;
type Resolver = { resolve(target: GraphResolve): Promise<GraphSessionIdentity> };

/** Stateless format/identity transport; graph edits and local durability belong to the host. */
export class GraphDataAdapter implements SessionExtensionSync {
  readonly protocolVersion = 1 as const;
  readonly namespaces = [namespace];
  private readonly revisions = new Map<string, number>();
  private enabled = true;
  constructor(private readonly bridge: MaintenanceExtensionBridge, private readonly identities: Resolver) {}
  private async transform(input: unknown, direction: 'native' | 'logical') {
    const graph = managedGraphSchema.parse(input);
    const ids = new Map<string, string>();
    const resolve = async (id: string) => {
      if (!ids.has(id)) {
        const value = await this.identities.resolve(direction === 'native' ? { logicalSessionId: id } : { nativeSessionId: id });
        ids.set(id, direction === 'native' ? value.nativeSessionId : value.logicalSessionId);
      }
      return ids.get(id)!;
    };
    if (!graph.ownerSessionId) throw new Error('历史图尚未绑定会话；原图保留，请先核验归属');
    graph.ownerSessionId = await resolve(graph.ownerSessionId);
    for (const node of graph.nodes) if (node.data.logicalSessionId) node.data.logicalSessionId = await resolve(node.data.logicalSessionId);
    return graph;
  }
  async read(requested: string, nativeSessionId?: string): Promise<SessionExtensionReplicaObject[]> {
    if (requested !== namespace) throw new Error('Unsupported graph namespace');
    const panels = await this.bridge.scopedPanels();
    const panel = panels.find(item => item.scope.namespace === namespace);
    this.enabled = panel?.status !== 'disabled';
    if (!this.enabled) return [];
    if (panel?.status !== 'ready') throw new Error('会话图同步 adapter 未就绪；请检查扩展页，原图保留');
    if (!nativeSessionId) return [];
    const identity = await this.identities.resolve({ nativeSessionId });
    const canonicalId = graphId(identity.logicalSessionId);
    let after: string | undefined;
    const seen = new Set<string>(), matching: ExtensionObject[] = [];
    do {
      const page = await this.bridge.list(namespace, after, 'all');
      for (const item of page.items) {
        const { object } = await this.bridge.get(namespace, item.objectId);
        const body = object.content.body as Record<string, JsonValue>;
        const owner = object.content.schemaVersion === 3 ? body.sessionId : body.ownerSessionId;
        if (owner === identity.logicalSessionId && (object.content.schemaVersion === 3 || object.content.schemaVersion === 2 && body.managedSchema === 2)) matching.push(object);
      }
      if (page.nextCursor && seen.has(page.nextCursor)) throw new Error('Invalid graph replica cursor');
      if (page.nextCursor) seen.add(page.nextCursor);
      after = page.nextCursor ?? undefined;
    } while (after);
    const canonical = matching.find(row => row.objectId === canonicalId && row.content.schemaVersion === 3);
    const legacy = matching.filter(row => row.content.schemaVersion === 2 && !row.deleted);
    if (!canonical && legacy.length > 1) throw new Error('会话存在多份历史图，需核验归属；不会选择空图覆盖');
    this.revisions.set(canonicalId, canonical?.revision ?? 0);
    const source = canonical ?? legacy[0];
    if (!source) return [];
    const body = source.content.body as Record<string, JsonValue>;
    const wrapped = source.content.schemaVersion === 3;
    const content = wrapped ? body.content as Record<string, JsonValue> : { title: source.content.title, graph: source.content.body };
    const graph = await this.transform(content.graph, 'native');
    return [{ sessionId: nativeSessionId, namespace, objectId: graphId(nativeSessionId), revision: wrapped ? Number(body.revision) : source.revision,
      deleted: source.deleted, content: { ...content, graph } as JsonValue }];
  }
  async commit(value: SessionExtensionReplicaObject): Promise<void> {
    if (!this.enabled) return;
    if (value.namespace !== namespace || value.objectId !== graphId(value.sessionId)) throw new Error('Invalid session graph identity');
    const content = value.content as Record<string, JsonValue>;
    const graph = await this.transform(content.graph, 'logical');
    const owner = (await this.identities.resolve({ nativeSessionId: value.sessionId })).logicalSessionId;
    if (graph.ownerSessionId !== owner) throw new Error('Graph owner differs from session');
    const objectId = graphId(owner), expectedRevision = this.revisions.get(objectId);
    if (expectedRevision === undefined) throw new Error('Read graph replica before writing');
    const body = { ...value, sessionId: owner, objectId, content: { ...content, graph } } as JsonValue;
    const result = await this.bridge.save(namespace, objectId, expectedRevision, {
      schemaVersion: 3, title: String(content.title ?? owner), body, references: [{ logicalSessionId: owner }],
    }, value.deleted);
    if (result.status === 'conflict') throw new Error('会话图真源已更新，请重新读取后再保存；当前编辑保留');
    this.revisions.set(objectId, result.object.revision);
  }
}
