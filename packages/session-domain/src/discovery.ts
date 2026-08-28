import {
  CONTRACT_SCHEMA_VERSION,
  SessionMaintenanceError,
  normalizedSessionSchema,
  type AdapterContractRef,
  type ContentObjectStore,
  type DiscoveryResult,
  type JsonValue,
  type LogicalSession,
  type MatchCandidate,
  type NormalizedEvent,
  type NormalizedSession,
  type ObservationRecord,
  type PlatformBinding,
  type PlatformSessionKey,
  type PlatformSessionSummary,
  type RegisteredInstance,
  type RepositoryWriteResult,
  type SessionReadAdapter,
  type SessionRepository,
  type StateFingerprint,
} from "@linmu/dsh-session-contracts";

import { canonicalJson, sha256Canonical } from "./canonical-json.js";

export function logicalSessionIdFor(key: PlatformSessionKey): string {
  return `ls_${sha256Canonical(key as unknown as JsonValue).slice(0, 24)}`;
}

export function bindingIdFor(key: PlatformSessionKey): string {
  return `binding_${sha256Canonical(key as unknown as JsonValue).slice(0, 24)}`;
}

export function versionIdFor(input: {
  readonly logicalSessionId: string;
  readonly parents: readonly string[];
  readonly bodyHash: string;
  readonly metadataHash: string;
}): string {
  return `sv_${sha256Canonical(input as unknown as JsonValue).slice(0, 24)}`;
}

export function candidateIdFor(input: {
  readonly leftBindingId: string;
  readonly rightKey: PlatformSessionKey;
  readonly reason: string;
}): string {
  return `match_${sha256Canonical(input as unknown as JsonValue).slice(0, 24)}`;
}

function catalogFingerprint(summary: PlatformSessionSummary): StateFingerprint {
  return {
    ...summary.key,
    kind: "catalog",
    value: sha256Canonical({
      key: summary.key,
      title: summary.title,
      archived: summary.archived,
      workspaceId: summary.workspaceId,
      workspaceLabel: summary.workspaceLabel ?? null,
      updatedAt: summary.updatedAt,
      hint: summary.hint,
    } as unknown as JsonValue),
  };
}

function semanticEvent(event: NormalizedEvent): JsonValue {
  return {
    kind: event.kind,
    role: event.role,
    content: event.content,
    attachments: event.attachments.map((attachment) => ({
      name: attachment.name,
      ...(attachment.mediaType === undefined ? {} : { mediaType: attachment.mediaType }),
      source: attachment.source,
    })),
  };
}

function semanticEvents(session: NormalizedSession): readonly JsonValue[] {
  return session.events.map(semanticEvent);
}

function isPrefix(left: readonly JsonValue[], right: readonly JsonValue[]): boolean {
  return left.length <= right.length && left.every((item, index) => canonicalJson(item) === canonicalJson(right[index]!));
}

function contentCompatible(left: NormalizedSession, right: NormalizedSession): boolean {
  const leftEvents = semanticEvents(left);
  const rightEvents = semanticEvents(right);
  return isPrefix(leftEvents, rightEvents) || isPrefix(rightEvents, leftEvents);
}

function hasUnrelatedRoot(left: NormalizedSession, right: NormalizedSession): boolean {
  const leftRoot = semanticEvents(left)[0];
  const rightRoot = semanticEvents(right)[0];
  return leftRoot !== undefined && rightRoot !== undefined && canonicalJson(leftRoot) !== canonicalJson(rightRoot);
}

function explicitProvenance(session: NormalizedSession): PlatformSessionKey | undefined {
  for (const event of session.events) {
    const value = event.extensions.provenance ?? event.extensions.origin;
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const candidate = value as Readonly<Record<string, JsonValue>>;
    if (
      (candidate.platform === "codex" || candidate.platform === "dsh") &&
      typeof candidate.instanceId === "string" &&
      typeof candidate.sessionId === "string"
    ) {
      return {
        platform: candidate.platform,
        instanceId: candidate.instanceId,
        sessionId: candidate.sessionId,
      };
    }
  }
  return undefined;
}

function sameKey(left: PlatformSessionKey, right: PlatformSessionKey): boolean {
  return left.platform === right.platform && left.instanceId === right.instanceId && left.sessionId === right.sessionId;
}

function addResult(left: DiscoveryResult, right: RepositoryWriteResult | DiscoveryResult): DiscoveryResult {
  return {
    createdLogicalSessions: left.createdLogicalSessions + right.createdLogicalSessions,
    createdBindings: left.createdBindings + right.createdBindings,
    createdVersions: left.createdVersions + right.createdVersions,
    createdCandidates: left.createdCandidates + right.createdCandidates,
    skippedSessions: left.skippedSessions + ("skippedSessions" in right ? right.skippedSessions : 0),
    platformWrites: 0,
  };
}

const EMPTY_RESULT: DiscoveryResult = {
  createdLogicalSessions: 0,
  createdBindings: 0,
  createdVersions: 0,
  createdCandidates: 0,
  skippedSessions: 0,
  platformWrites: 0,
};

interface DiscoveryPeer {
  readonly session: NormalizedSession;
  readonly binding: PlatformBinding;
}

export interface DiscoveryServiceOptions {
  readonly instances: readonly RegisteredInstance[];
  readonly adapters: readonly SessionReadAdapter[];
  readonly repository: SessionRepository;
  readonly objectStore: ContentObjectStore;
}

export class DiscoveryService {
  private readonly instances: ReadonlyMap<string, RegisteredInstance>;
  private readonly adapters: ReadonlyMap<RegisteredInstance["platform"], SessionReadAdapter>;
  private readonly repository: SessionRepository;
  private readonly objectStore: ContentObjectStore;
  private readonly peers = new Map<string, DiscoveryPeer>();
  private readonly concurrency: number;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: DiscoveryServiceOptions) {
    this.instances = new Map(options.instances.map((instance) => [instance.id, instance]));
    this.adapters = new Map(options.adapters.map((adapter) => [adapter.platform, adapter]));
    this.repository = options.repository;
    this.objectStore = options.objectStore;
    this.concurrency = 4;
  }

  async scanAll(instanceIds: readonly string[] = [...this.instances.keys()]): Promise<DiscoveryResult> {
    let result = EMPTY_RESULT;
    for (const instanceId of instanceIds) result = addResult(result, await this.scanInstance(instanceId));
    return result;
  }

  async scanInstance(instanceId: string): Promise<DiscoveryResult> {
    const instance = this.instances.get(instanceId);
    if (instance === undefined) throw new TypeError(`Unknown instance: ${instanceId}`);
    const adapter = this.adapters.get(instance.platform);
    if (adapter === undefined) throw new TypeError(`No adapter for platform: ${instance.platform}`);
    const probe = await adapter.probe(instance);
    if (probe.status === "unsupported") {
      throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", `Adapter rejected ${instance.id}`, {
        details: probe.issues as unknown as JsonValue,
      });
    }

    const summaries: PlatformSessionSummary[] = [];
    for await (const summary of adapter.list(instance)) summaries.push(summary);
    const results: RepositoryWriteResult[] = new Array(summaries.length);
    let skippedSessions = 0;
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        const summary = summaries[index];
        if (summary === undefined) return;
        try {
          results[index] = await this.scanSummary(instance, adapter, probe.contract, summary);
        } catch (error) {
          if (error instanceof SessionMaintenanceError && error.code === "CONTENT_TOO_LARGE") {
            skippedSessions += 1;
            results[index] = { createdLogicalSessions: 0, createdBindings: 0, createdVersions: 0, createdCandidates: 0 };
            continue;
          }
          throw error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, summaries.length) }, worker));
    return {
      ...results.reduce<DiscoveryResult>((result, item) => addResult(result, item), EMPTY_RESULT),
      skippedSessions,
    };
  }

  private async scanSummary(
    instance: RegisteredInstance,
    adapter: SessionReadAdapter,
    contract: AdapterContractRef,
    summary: PlatformSessionSummary,
  ): Promise<RepositoryWriteResult> {
      const binding = await this.repository.findBinding(summary.key);
      if (binding !== undefined) {
        await this.enqueueWrite(() => this.repository.recordWorkspaceMembership({
          bindingId: binding.id,
          workspaceId: summary.workspaceId,
          displayName: summary.workspaceLabel ?? null,
        }));
      }
      const head = binding === undefined ? undefined : await this.repository.getObservedHead(binding.id);
      const fingerprint = catalogFingerprint(summary);
      if (head?.fingerprint.kind === "catalog" && head.fingerprint.value === fingerprint.value) {
        return { createdLogicalSessions: 0, createdBindings: 0, createdVersions: 0, createdCandidates: 0 };
      }

      const observation = await adapter.observe(instance, summary.key, summary.hint);
      if (observation.kind === "unstable") {
        return { createdLogicalSessions: 0, createdBindings: 0, createdVersions: 0, createdCandidates: 0 };
      }
      const normalized = await adapter.normalize(observation);
      const previous = head === undefined ? undefined : await this.loadVersionBody(binding!, head.versionId);
      if (previous !== undefined && hasUnrelatedRoot(previous, normalized)) {
        throw new SessionMaintenanceError(
          "IDENTITY_CONFLICT",
          `Platform session key was reused for unrelated content: ${summary.key.platform}/${summary.key.instanceId}/${summary.key.sessionId}`,
        );
      }

      const resolved = await this.resolveIdentity(normalized, binding, contract);
      const parents = head === undefined ? [] : [head.versionId];
      if (previous !== undefined && previous.bodyHash === normalized.bodyHash && previous.metadataHash === normalized.metadataHash) {
        await this.enqueueWrite(() => this.repository.recordObservation({
          bindingId: resolved.binding.id,
          versionId: head!.versionId,
          observedAt: normalized.provenance.observedAt,
          fingerprint,
        }));
        this.peers.set(resolved.binding.id, { session: normalized, binding: resolved.binding });
        return { createdLogicalSessions: 0, createdBindings: 0, createdVersions: 0, createdCandidates: 0 };
      }

      const bodyObject = await this.objectStore.put(Buffer.from(canonicalJson(normalized as unknown as JsonValue)));
      const versionId = versionIdFor({
        logicalSessionId: resolved.logicalSession.id,
        parents,
        bodyHash: normalized.bodyHash,
        metadataHash: normalized.metadataHash,
      });
      const candidates = this.matchCandidates(normalized, resolved.binding);
      const record: ObservationRecord = {
        logicalSession: resolved.logicalSession,
        binding: resolved.binding,
        version: {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          id: versionId,
          logicalSessionId: resolved.logicalSession.id,
          parents,
          bodyObject,
          bodyHash: normalized.bodyHash,
          metadataHash: normalized.metadataHash,
          source: normalized.provenance,
          compatibility: normalized.compatibility,
        },
        head: {
          bindingId: resolved.binding.id,
          versionId,
          observedAt: normalized.provenance.observedAt,
          fingerprint,
        },
        candidates,
      };
      const result = await this.enqueueWrite(async () => {
        const written = await this.repository.recordObservedVersion(record);
        await this.repository.recordWorkspaceMembership({
          bindingId: resolved.binding.id,
          workspaceId: summary.workspaceId,
          displayName: summary.workspaceLabel ?? null,
        });
        return written;
      });
      this.peers.set(resolved.binding.id, { session: normalized, binding: resolved.binding });
    return result;
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async loadVersionBody(binding: PlatformBinding, versionId: string): Promise<NormalizedSession> {
    const page = await this.repository.getGraphPage(binding.logicalSessionId);
    const manifest = page.nodes.find((node) => node.id === versionId);
    if (manifest === undefined) {
      throw new SessionMaintenanceError("OBJECT_CORRUPT", `Observed version is missing: ${versionId}`);
    }
    const bytes = await this.objectStore.get(manifest.bodyObject);
    return normalizedSessionSchema.parse(
      JSON.parse(Buffer.from(bytes).toString("utf8")),
    ) as unknown as NormalizedSession;
  }

  private async resolveIdentity(
    session: NormalizedSession,
    existing: PlatformBinding | undefined,
    contract: AdapterContractRef,
  ): Promise<{ readonly logicalSession: LogicalSession; readonly binding: PlatformBinding }> {
    if (existing !== undefined) {
      return {
        logicalSession: {
          id: existing.logicalSessionId,
          displayTitle: session.title,
          canonicalVersionId: null,
          syncMode: "paused",
          archived: session.archived,
          labels: [],
          createdAt: session.provenance.observedAt,
        },
        binding: existing,
      };
    }

    const provenance = explicitProvenance(session);
    let logicalSessionId = logicalSessionIdFor(session.key);
    if (provenance !== undefined) {
      const linked = await this.repository.findBinding(provenance);
      const peer = linked === undefined ? undefined : this.peers.get(linked.id);
      if (linked !== undefined && peer !== undefined && contentCompatible(peer.session, session)) {
        logicalSessionId = linked.logicalSessionId;
      }
    }
    const logicalSession: LogicalSession = {
      id: logicalSessionId,
      displayTitle: session.title,
      canonicalVersionId: null,
      syncMode: "paused",
      archived: session.archived,
      labels: [],
      createdAt: session.provenance.observedAt,
    };
    return {
      logicalSession,
      binding: {
        id: bindingIdFor(session.key),
        logicalSessionId,
        key: session.key,
        adapterContract: contract,
        lastCommonVersionId: null,
        status: "read-only",
      },
    };
  }

  private matchCandidates(session: NormalizedSession, binding: PlatformBinding): readonly MatchCandidate[] {
    const candidates: MatchCandidate[] = [];
    for (const peer of this.peers.values()) {
      if (peer.binding.key.platform === binding.key.platform || sameKey(peer.binding.key, binding.key)) continue;
      const compatible = contentCompatible(peer.session, session);
      const sameWorkspace = session.workspaceId !== null && session.workspaceId === peer.session.workspaceId;
      const sameTitle = session.title.trim().length > 0 && session.title.trim() === peer.session.title.trim();
      const reason = compatible && sameWorkspace ? "compatible-content-workspace" : sameTitle ? "same-title" : undefined;
      if (reason === undefined) continue;
      const identity = { leftBindingId: peer.binding.id, rightKey: binding.key, reason };
      candidates.push({
        id: candidateIdFor(identity),
        ...identity,
        confidence: compatible && sameWorkspace ? "high" : "low",
        createdAt: session.provenance.observedAt,
      });
    }
    return candidates;
  }
}
