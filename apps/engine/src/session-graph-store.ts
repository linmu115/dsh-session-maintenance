import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SqliteExtensionRepository } from "@linmu/dsh-session-store";
import {
  ExtensionDataError, managedGraphSchema, legacyManagedGraphSchema, graphDisclosureLogSchema,
  graphDisclosureInputSchema, sessionContextRecordSchema,
  type ExtensionScope, type ExtensionObject, type ManagedGraph, type GraphDocument, type GraphSave,
  type GraphRemove, type GraphDisclosureInput, type GraphDisclosureReceipt, type GraphDisclosurePage,
  type GraphDisclosureCoverage,
  type SessionContextRecord, type JsonValue,
} from "@linmu/dsh-session-contracts";

const fail = (message: string) => new ExtensionDataError("GRAPH_CONFLICT", message, 409);
const hash = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export const graphObjectId = (owner: string) => `main-${hash(owner)}`;
const logObjectId = (owner: string) => `disclosures-${hash(owner)}`;
const document = (object: ExtensionObject, graph = managedGraphSchema.parse(object.content.body)): GraphDocument =>
  ({ objectId: object.objectId, revision: object.revision, title: object.title, graph });

/** Domain writes use one repository transaction, including authoritative revocation.
 * This store never creates native sessions or retains a source version. */
export class SessionGraphStore {
  readonly store: SqliteExtensionRepository;
  readonly maxEntries: number;
  readonly maxBytes: number;
  constructor(private readonly db: DatabaseSync, limits = {
    maxEntries: Number(process.env.DSH_GRAPH_LOG_MAX_ENTRIES ?? 256),
    maxBytes: Number(process.env.DSH_GRAPH_LOG_MAX_BYTES ?? 262144),
  }) {
    this.store = new SqliteExtensionRepository(db);
    if (!Number.isInteger(limits.maxEntries) || limits.maxEntries < 1 || limits.maxEntries > 256 ||
        !Number.isInteger(limits.maxBytes) || limits.maxBytes < 8192 || limits.maxBytes > 262144)
      throw new Error("Graph log limits must be 1..256 entries and 8192..262144 bytes");
    this.maxEntries = limits.maxEntries; this.maxBytes = limits.maxBytes;
  }
  reference(scope: ExtensionScope, referenceId: string) {
    const object = this.store.get({ ...scope, namespace: "annotation-upstream" }, referenceId);
    if (!object || object.deleted) throw fail("引用对象不存在或已删除");
    return { object, record: sessionContextRecordSchema.parse(object.content.body) };
  }
  private write(scope: ExtensionScope, writerId: string, objectId: string, revision: number, graph: ManagedGraph, title: string) {
    graph = this.normalize(scope, graph);
    managedGraphSchema.parse(graph);
    const references = [...new Set(graph.nodes.flatMap(node => node.data.logicalSessionId ? [node.data.logicalSessionId] : []))]
      .slice(0, 500).map(logicalSessionId => ({ logicalSessionId }));
    const result = this.store.write({ scope, writerId, objectId, expectedRevision: revision, deleted: false,
      content: { schemaVersion: 2, title, body: JSON.parse(JSON.stringify(graph)) as JsonValue, references } });
    if (result.status === "conflict") throw fail("图已被其他操作修改，请刷新后重试；本地编辑仍需保留");
    return document(result.object);
  }
  private normalize(scope: ExtensionScope, graph: ManagedGraph) {
    const removed = new Set(graph.removedRelationIds ?? []);
    const edges = graph.edges.flatMap(edge => {
      if (!edge.data.relationId) return [edge];
      try {
        const record = this.reference(scope, edge.data.relationId).record;
        if (record.state === "revoked" || removed.has(edge.data.relationId)) return [];
        return [{ ...edge, data: { ...edge.data, sourceVersionId: record.sourceVersionId, cutoffEventId: record.cutoffEventId,
          sourceAnchorId: record.sourceAnchorId, state: record.state, targetMessageId: record.targetMessageId } }];
      } catch { return []; }
    });
    return { ...graph, edges };
  }
  private validateReferences(scope: ExtensionScope, graph: ManagedGraph) {
    for (const edge of graph.edges) {
      if (edge.data.kind === "pending") continue;
      const record = this.reference(scope, edge.data.relationId!).record;
      const source = graph.nodes.find(node => node.id === edge.source), target = graph.nodes.find(node => node.id === edge.target);
      if (record.state === "revoked" || (graph.removedRelationIds ?? []).includes(record.referenceId)) throw fail("已解除的关系不能重新导入");
      if (source?.data.logicalSessionId !== record.sourceSessionId || target?.data.logicalSessionId !== record.targetSessionId)
        throw fail("连接端点与权威引用所属会话不一致");
      if (!graph.ownerSessionId) throw fail("活动上下文关系必须先确定主干会话");
    }
  }
  load(scope: ExtensionScope, objectId: string): GraphDocument {
    const object = this.store.get(scope, objectId);
    if (!object || object.deleted) throw fail("图不存在或已删除");
    if (object.schemaVersion === 2) return document(object, this.normalize(scope, managedGraphSchema.parse(object.content.body)));
    const old = legacyManagedGraphSchema.parse(object.content.body);
    const targets = new Set<string>(); let verified = true;
    const active = old.edges.filter(edge => edge.data.kind !== "knowledge").flatMap(edge => {
      try {
        const record = this.reference(scope, edge.data.relationId!).record;
        if (old.nodes.find(n => n.id === edge.source)?.data.logicalSessionId !== record.sourceSessionId ||
            old.nodes.find(n => n.id === edge.target)?.data.logicalSessionId !== record.targetSessionId) { verified = false; return []; }
        targets.add(record.targetSessionId);
        return record.state === "revoked" ? [] : [{ ...edge, data: { ...edge.data, kind: edge.data.kind as "branch" | "upstream" } }];
      } catch { verified = false; return []; }
    });
    const owner = verified && targets.size === 1 ? [...targets][0]! : null;
    return document(object, { managedSchema: 2, ownerSessionId: owner, nodes: old.nodes,
      edges: owner ? active : [], viewport: old.viewport,
      legacyEdges: old.edges.filter(edge => edge.data.kind === "knowledge" || !owner),
      migration: { sourceObjectId: objectId, status: owner ? "verified" : "needs-review",
        reason: owner ? "已核对唯一接收会话；原画布保留" : "旧图归属不能唯一核验，请确定归属或拆分；旧线未授权读取" } });
  }
  ensure(scope: ExtensionScope, writerId: string, owner: string, title: string): GraphDocument {
    const objectId = graphObjectId(owner), current = this.store.get(scope, objectId);
    if (current) return this.load(scope, objectId);
    return this.write(scope, writerId, objectId, 0, { managedSchema: 2, ownerSessionId: owner,
      nodes: [{ id: `session-${hash(owner)}`, position: { x: 450, y: 250 }, data: { kind: "session", logicalSessionId: owner, label: title } }], edges: [] }, title);
  }
  save(scope: ExtensionScope, writerId: string, input: GraphSave): GraphDocument {
    return this.store.transaction(() => {
      const graph = managedGraphSchema.parse(input.graph);
      let objectId = input.objectId ?? (graph.ownerSessionId ? graphObjectId(graph.ownerSessionId) : `draft-${randomUUID()}`);
      let revision = input.expectedRevision;
      let current = this.store.get(scope, objectId);
      if (current?.schemaVersion === 1) {
        if (graph.migration?.sourceObjectId !== objectId) throw fail("旧图必须明确迁移后保存，原对象将保留");
        objectId = graph.ownerSessionId ? graphObjectId(graph.ownerSessionId) : `draft-${randomUUID()}`;
        const existing = this.store.get(scope, objectId);
        if (existing) return { ...this.load(scope, objectId), reused: true, draftObjectId: input.objectId };
        current = undefined; revision = 0;
      }
      if (graph.ownerSessionId && objectId !== graphObjectId(graph.ownerSessionId)) throw fail("请通过绑定操作确定主干身份");
      if (current) {
        const old = managedGraphSchema.parse(current.content.body);
        if (old.ownerSessionId !== graph.ownerSessionId) throw fail("不能通过布局保存改变主干身份");
        graph.removedRelationIds = [...new Set([...(old.removedRelationIds ?? []), ...(graph.removedRelationIds ?? [])])];
        const kept = new Set(graph.edges.flatMap(edge => edge.data.relationId ? [edge.data.relationId] : []));
        for (const edge of this.normalize(scope, old).edges) if (edge.data.relationId && !kept.has(edge.data.relationId))
          throw fail("移除活动连接必须使用统一移除操作");
      }
      this.validateReferences(scope, graph);
      return this.write(scope, writerId, objectId, revision, graph, input.title ?? current?.title ?? "会话主干图");
    });
  }
  bind(scope: ExtensionScope, writerId: string, objectId: string, expectedRevision: number, owner: string, title: string) {
    return this.store.transaction(() => {
      const draft = this.load(scope, objectId);
      if (draft.revision !== expectedRevision) throw fail("待绑定画布已变化，请刷新");
      if (draft.graph.ownerSessionId && draft.graph.ownerSessionId !== owner) throw fail("图已绑定其他主干会话");
      const targetId = graphObjectId(owner);
      if (objectId === targetId) return draft;
      if (this.store.get(scope, targetId)) return { ...this.load(scope, targetId), reused: true, draftObjectId: objectId };
      const graph = { ...draft.graph, ownerSessionId: owner };
      if (!graph.nodes.some(node => node.data.logicalSessionId === owner)) graph.nodes.push({ id: `session-${hash(owner)}`,
        position: { x: 450, y: 250 }, data: { kind: "session", logicalSessionId: owner, label: title } });
      this.validateReferences(scope, graph);
      return { ...this.write(scope, writerId, targetId, 0, graph, title), draftObjectId: objectId };
    });
  }
  syncReference(scope: ExtensionScope, writerId: string, record: SessionContextRecord, sourceTitle: string, targetTitle: string) {
    return this.store.transaction(() => {
      const existing = this.store.get(scope, graphObjectId(record.targetSessionId));
      if (!existing && record.state === "revoked") return null;
      const doc = existing ? document(existing) : this.ensure(scope, writerId, record.targetSessionId, targetTitle);
      const graph = doc.graph, removed = new Set(graph.removedRelationIds ?? []);
      if (record.state === "revoked") {
        removed.add(record.referenceId); graph.removedRelationIds = [...removed];
        graph.edges = graph.edges.filter(edge => edge.data.relationId !== record.referenceId);
      } else if (!removed.has(record.referenceId)) {
        const node = (session: string, label: string) => {
          let value = graph.nodes.find(n => n.data.logicalSessionId === session);
          if (!value) { value = { id: `session-${hash(session)}`, position: { x: 100, y: 100 + graph.nodes.length * 120 },
            data: { kind: "session", logicalSessionId: session, label } }; graph.nodes.push(value); }
          return value.id;
        };
        const source = node(record.sourceSessionId, sourceTitle), target = node(record.targetSessionId, targetTitle);
        if (!graph.edges.some(edge => edge.data.relationId === record.referenceId)) graph.edges.push({
          id: `reference-${hash(record.referenceId)}`, source, target,
          data: { kind: "upstream", namespace: "annotation-upstream", relationId: record.referenceId } });
      }
      return this.write(scope, writerId, doc.objectId, doc.revision, graph, doc.title);
    });
  }
  remove(scope: ExtensionScope, writerId: string, input: GraphRemove) {
    return this.store.transaction(() => {
      const object = this.store.get(scope, input.objectId);
      if (!object || object.schemaVersion !== 2) throw fail("请先保存已核验的新版画布，再移除连接");
      const doc = document(object), nodes = new Set(input.nodeIds ?? []), edges = new Set(input.edgeIds ?? []);
      const affected = doc.graph.edges.filter(edge => edges.has(edge.id) || nodes.has(edge.source) || nodes.has(edge.target));
      const hasNode = doc.graph.nodes.some(node => nodes.has(node.id));
      if (!affected.length && !hasNode) return this.load(scope, input.objectId); // retry of an already committed removal
      if (doc.revision !== input.expectedRevision) throw fail("图已变化，请刷新后确认移除范围");
      const removed = new Set(doc.graph.removedRelationIds ?? []);
      for (const edge of affected) if (edge.data.relationId) {
        removed.add(edge.data.relationId);
        const reference = this.store.get({ ...scope, namespace: "annotation-upstream" }, edge.data.relationId);
        if (!reference || reference.deleted) continue;
        const parsed = sessionContextRecordSchema.safeParse(reference.content.body);
        if (!parsed.success) continue; // An unreadable reference cannot grant context; its stale presentation can be removed.
        const record = parsed.data;
        if (record.state !== "revoked") {
          const result = this.store.write({ scope: reference.scope, writerId: reference.writerId, objectId: reference.objectId,
            expectedRevision: reference.revision, deleted: false,
            content: { ...reference.content, body: { ...record, state: "revoked" } as unknown as JsonValue } });
          if (result.status === "conflict") throw fail("引用状态已变化，请重试");
        }
      }
      doc.graph.nodes = doc.graph.nodes.filter(node => !nodes.has(node.id));
      const affectedIds = new Set(affected.map(edge => edge.id));
      doc.graph.edges = doc.graph.edges.filter(edge => !affectedIds.has(edge.id));
      doc.graph.removedRelationIds = [...removed];
      return this.write(scope, writerId, doc.objectId, doc.revision, doc.graph, doc.title);
    });
  }
  appendDisclosure(scope: ExtensionScope, writerId: string, record: SessionContextRecord, raw: GraphDisclosureInput): GraphDisclosureReceipt {
    const input = graphDisclosureInputSchema.parse(raw);
    return this.store.transaction(() => {
      const objectId = logObjectId(record.targetSessionId), current = this.store.get(scope, objectId);
      const log = current ? graphDisclosureLogSchema.parse(current.content.body) : { kind: "disclosure-log" as const,
        managedSchema: 2 as const, ownerSessionId: record.targetSessionId, graphObjectId: graphObjectId(record.targetSessionId),
        trimmed: false, trimmedCount: 0, items: [] as GraphDisclosureReceipt[] };
      const receiptId = `receipt-${hash(record.referenceId, input.executionId, input.requestId)}`;
      const old = log.items.find(item => item.receiptId === receiptId);
      const receipt: GraphDisclosureReceipt = { ...input, receiptId, referenceId: record.referenceId,
        sourceSessionId: record.sourceSessionId, targetSessionId: record.targetSessionId,
        sourceVersionId: record.sourceVersionId, cutoffEventId: record.cutoffEventId, recordedAt: old?.recordedAt ?? new Date().toISOString() };
      if (old) {
        const compare = (value: GraphDisclosureReceipt) => JSON.stringify({ ...value, delivery: "prepared", recordedAt: "" });
        if (compare(old) !== compare(receipt)) throw fail("同一读取请求的范围发生变化，不能覆盖既有回执");
        if (old.delivery === receipt.delivery || (old.delivery === "returned" && receipt.delivery === "prepared")) return old;
        if (old.delivery === "failed") throw fail("已取消的读取不能重新标记为已交付");
        Object.assign(old, receipt);
      } else log.items.push(receipt);
      while (log.items.length > this.maxEntries || Buffer.byteLength(JSON.stringify(log)) > this.maxBytes) {
        if (log.items.length <= 1) throw fail("本次读取位置超过日志容量，请缩小读取页");
        log.items.shift(); log.trimmed = true; log.trimmedCount++;
      }
      graphDisclosureLogSchema.parse(log);
      const result = this.store.write({ scope, writerId, objectId, expectedRevision: current?.revision ?? 0, deleted: false,
        content: { schemaVersion: 2, title: `读取位置 · ${record.targetSessionId}`.slice(0, 500), body: log as unknown as JsonValue,
          references: [{ logicalSessionId: record.targetSessionId }] } });
      if (result.status === "conflict") throw fail("读取位置保存冲突，请重试");
      return receipt;
    });
  }
  disclosures(scope: ExtensionScope, owner: string, after?: string): GraphDisclosurePage {
    const object = this.store.get(scope, logObjectId(owner));
    const log = object ? graphDisclosureLogSchema.parse(object.content.body) : { items: [], trimmed: false, trimmedCount: 0 };
    const index = after ? log.items.findIndex(item => item.receiptId === after) : -1;
    if (after && index < 0) throw fail("读取记录游标已裁剪或无效，请从最近记录重新读取");
    const items = log.items.slice(index + 1, index + 21);
    const groups = new Map<string, GraphDisclosureCoverage>();
    for (const item of items) if (item.delivery === "returned") for (const range of item.ranges) {
      const key = JSON.stringify([item.referenceId, item.sourceVersionId, item.executionId, range.eventId]);
      let group = groups.get(key);
      if (!group) { group = { referenceId: item.referenceId, sourceVersionId: item.sourceVersionId,
        executionId: item.executionId, eventId: range.eventId, ranges: [] }; groups.set(key, group); }
      group.ranges.push({ start: range.start, end: range.end });
    }
    const coverage: GraphDisclosureCoverage[] = []; let coverageBytes = 2, coverageTruncated = false;
    for (const group of groups.values()) {
      const merged: GraphDisclosureCoverage["ranges"] = [];
      for (const range of group.ranges.sort((a, b) => a.start - b.start || a.end - b.end)) {
        const previous = merged.at(-1);
        if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
        else merged.push({ ...range });
      }
      group.ranges = merged; const bytes = Buffer.byteLength(JSON.stringify(group)) + 1;
      if (coverage.length >= 128 || coverageBytes + bytes > 65536) { coverageTruncated = true; break; }
      coverage.push(group); coverageBytes += bytes;
    }
    return { items, nextCursor: index + 21 < log.items.length ? items.at(-1)!.receiptId : null,
      trimmed: log.trimmed, trimmedCount: log.trimmedCount, maxEntries: this.maxEntries, maxBytes: this.maxBytes, coverage, coverageTruncated };
  }
  settleDisclosure(scope: ExtensionScope, writerId: string, record: SessionContextRecord, requestId: string, delivery: "returned" | "failed") {
    const object = this.store.get(scope, logObjectId(record.targetSessionId));
    if (!object || object.deleted) return { recorded: false as const, reason: "not-recorded-or-trimmed" as const };
    const log = graphDisclosureLogSchema.parse(object.content.body);
    const matching = log.items.filter(item => item.referenceId === record.referenceId && item.requestId === requestId);
    if (matching.length === 0) return { recorded: false as const, reason: "not-recorded-or-trimmed" as const };
    if (matching.length !== 1) throw fail("读取回执请求身份不唯一");
    const { receiptId: _id, referenceId: _ref, sourceSessionId: _source, targetSessionId: _target,
      sourceVersionId: _version, cutoffEventId: _cutoff, recordedAt: _at, ...input } = matching[0]!;
    this.appendDisclosure(scope, writerId, record, { ...input, delivery });
    return { recorded: true as const };
  }
}
