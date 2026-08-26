import {
  SessionMaintenanceError,
  normalizedSessionSchema,
  type DiffRequest,
  type DiscoveryResult,
  type EngineStatus,
  type InstanceStatus,
  type NormalizedEvent,
  type NormalizedSession,
  type Page,
  type PlanRequest,
  type PlatformBinding,
  type ReadOnlyEngine,
  type RegisteredInstance,
  type ScanRequest,
  type SessionDiff,
  type SessionQuery,
  type SessionReadAdapter,
  type SessionRepository,
  type SessionSummary,
  type SyncPlan,
  type VersionGraphPage,
  type ContentObjectStore,
} from "@linmu/dsh-session-contracts";
import { DiscoveryService, PlanningService, VersionGraph, classifyHeads } from "@linmu/dsh-session-domain";

function semanticEvents(events: readonly NormalizedEvent[]): readonly string[] {
  return events.map((event) => JSON.stringify({
    kind: event.kind,
    role: event.role,
    content: event.content,
    attachments: event.attachments,
  }));
}

function prefix(left: readonly string[], right: readonly string[]): boolean {
  return left.length <= right.length && left.every((value, index) => value === right[index]);
}

export class SessionMaintenanceEngine implements ReadOnlyEngine {
  readonly instances: readonly RegisteredInstance[];
  readonly adapters: readonly SessionReadAdapter[];
  readonly repository: SessionRepository;
  readonly objectStore: ContentObjectStore;
  private readonly discovery: DiscoveryService;
  private lastScanAt: string | undefined;
  private readonly clock: () => string;

  constructor(input: {
    readonly instances: readonly RegisteredInstance[];
    readonly adapters: readonly SessionReadAdapter[];
    readonly repository: SessionRepository;
    readonly objectStore: ContentObjectStore;
    readonly clock?: () => string;
  }) {
    this.instances = input.instances;
    this.adapters = input.adapters;
    this.repository = input.repository;
    this.objectStore = input.objectStore;
    this.clock = input.clock ?? (() => new Date().toISOString());
    this.discovery = new DiscoveryService(input);
  }

  async listInstances(): Promise<readonly InstanceStatus[]> {
    const byPlatform = new Map(this.adapters.map((adapter) => [adapter.platform, adapter]));
    return Promise.all(this.instances.map(async (instance) => {
      const adapter = byPlatform.get(instance.platform);
      if (adapter === undefined) throw new TypeError(`No adapter for ${instance.platform}`);
      const probe = await adapter.probe(instance);
      return {
        id: instance.id,
        platform: instance.platform,
        displayName: instance.displayName,
        compatibility: { status: probe.status, issues: probe.issues },
      };
    }));
  }

  listSessions(query: SessionQuery): Promise<Page<SessionSummary>> {
    return this.repository.listSessions(query);
  }

  getGraph(id: string, cursor?: string): Promise<VersionGraphPage> {
    return this.repository.getGraphPage(id, cursor);
  }

  async scan(request: ScanRequest): Promise<DiscoveryResult> {
    const result = await this.discovery.scanAll(request.instanceIds);
    this.lastScanAt = this.clock();
    return result;
  }

  async diff(request: DiffRequest): Promise<SessionDiff> {
    const pair = await this.resolvePair(request);
    const graphData = await this.repository.getGraph(request.logicalSessionId);
    const relation = classifyHeads(new VersionGraph(graphData.nodes), pair.sourceHead.versionId, pair.targetHead.versionId);
    const source = await this.loadSession(request.logicalSessionId, pair.sourceHead.versionId);
    const target = await this.loadSession(request.logicalSessionId, pair.targetHead.versionId);
    const sourceEvents = semanticEvents(source.events);
    const targetEvents = semanticEvents(target.events);
    const conversation = sourceEvents.length === targetEvents.length && prefix(sourceEvents, targetEvents)
      ? "unchanged"
      : prefix(targetEvents, sourceEvents) || prefix(sourceEvents, targetEvents)
        ? "append-only"
        : "rewritten";
    return {
      relation: relation.kind,
      conversation,
      metadata: source.title === target.title && source.archived === target.archived ? "unchanged" : "metadata-conflict",
      ...(relation.kind === "diverged" ? { mergeBase: relation.mergeBase } : {}),
    };
  }

  async createPlan(request: PlanRequest): Promise<SyncPlan> {
    const pair = await this.resolvePair(request);
    const source = await this.loadSession(request.logicalSessionId, pair.sourceHead.versionId);
    const target = await this.loadSession(request.logicalSessionId, pair.targetHead.versionId);
    const sourceSnapshot = { bindingId: pair.source.id, key: pair.source.key, versionId: pair.sourceHead.versionId, fingerprints: [pair.sourceHead.fingerprint] };
    const targetSnapshot = { bindingId: pair.target.id, key: pair.target.key, versionId: pair.targetHead.versionId, fingerprints: [pair.targetHead.fingerprint] };
    return new PlanningService(this.repository).create({
      createdAt: request.createdAt,
      logicalSessionId: request.logicalSessionId,
      baseVersionId: pair.targetHead.versionId,
      base: { events: target.events, metadata: { title: target.title, archived: target.archived } },
      source: { snapshot: sourceSnapshot, events: source.events, metadata: { title: source.title, archived: source.archived } },
      target: { kind: "present", head: { snapshot: targetSnapshot, events: target.events, metadata: { title: target.title, archived: target.archived } } },
      adapterContracts: [pair.source.adapterContract, pair.target.adapterContract],
    });
  }

  getPlan(id: string): Promise<SyncPlan | undefined> {
    return this.repository.getPlan(id);
  }

  status(): Promise<EngineStatus> {
    return Promise.resolve({
      ready: true,
      instanceCount: this.instances.length,
      ...(this.lastScanAt === undefined ? {} : { lastScanAt: this.lastScanAt }),
    });
  }

  close(): void {
    const close = this.repository as SessionRepository & { readonly close?: () => void };
    close.close?.();
  }

  private async resolvePair(request: DiffRequest) {
    const bindings = await this.repository.listBindings(request.logicalSessionId);
    const source = request.sourceBindingId === undefined ? bindings[0] : bindings.find((item) => item.id === request.sourceBindingId);
    const target = request.targetBindingId === undefined
      ? bindings.find((item) => item.id !== source?.id)
      : bindings.find((item) => item.id === request.targetBindingId);
    if (source === undefined || target === undefined) {
      throw new SessionMaintenanceError("IDENTITY_CONFLICT", `Logical session does not have the requested binding pair: ${request.logicalSessionId}`);
    }
    const sourceHead = await this.repository.getObservedHead(source.id);
    const targetHead = await this.repository.getObservedHead(target.id);
    if (sourceHead === undefined || targetHead === undefined) throw new SessionMaintenanceError("OBJECT_CORRUPT", "Binding head is missing");
    return { source, target, sourceHead, targetHead };
  }

  private async loadSession(logicalSessionId: string, versionId: string): Promise<NormalizedSession> {
    let cursor: string | undefined;
    do {
      const page = await this.repository.getGraphPage(logicalSessionId, cursor);
      const manifest = page.nodes.find((node) => node.id === versionId);
      if (manifest !== undefined) {
        const bytes = await this.objectStore.get(manifest.bodyObject);
        return normalizedSessionSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8"))) as unknown as NormalizedSession;
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    throw new SessionMaintenanceError("OBJECT_CORRUPT", `Version is missing: ${versionId}`);
  }
}
