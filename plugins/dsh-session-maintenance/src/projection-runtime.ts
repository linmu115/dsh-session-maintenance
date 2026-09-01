import type {
  JsonValue,
  NativeAppendOperation,
  NativeSessionId,
  RuntimeBrokerAttachRunRequest,
  RuntimeBrokerFlushRequest,
} from "@linmu/dsh-session-contracts";

import type { EngineConnectionProvider } from "./engine-proxy.js";

export interface ProjectionRuntimeDescriptor {
  readonly runId: string;
  readonly maintenanceEndpoint: string;
}

export interface ProjectionRuntimeSnapshot {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sessions: readonly {
    readonly nativeSessionId: string;
    readonly payload: JsonValue;
  }[];
}

export interface ProjectionRuntimeTransport {
  load(input: ProjectionRuntimeDescriptor): Promise<ProjectionRuntimeSnapshot>;
}

export interface ProjectionPersistenceOverlay {
  attach(snapshot: ProjectionRuntimeSnapshot): Promise<string>;
  beginDrain(registrationId: string): Promise<void>;
  pending(registrationId: string): Promise<number>;
  hideSession(registrationId: string, nativeSessionId: string): Promise<void>;
  detach(registrationId: string): Promise<void>;
}

export class Alpha2ProjectionPersistenceOverlay implements ProjectionPersistenceOverlay {
  private readonly snapshots = new Map<string, ProjectionRuntimeSnapshot>();
  private readonly draining = new Set<string>();

  async attach(snapshot: ProjectionRuntimeSnapshot): Promise<string> {
    const registrationId = `projection:${snapshot.runId}`;
    if (this.snapshots.has(registrationId)) throw new Error(`Projection overlay already exists: ${snapshot.runId}`);
    this.snapshots.set(registrationId, structuredClone(snapshot));
    return registrationId;
  }

  async pending(registrationId: string): Promise<number> {
    this.snapshot(registrationId);
    return 0;
  }

  async beginDrain(registrationId: string): Promise<void> {
    this.snapshot(registrationId);
    this.draining.add(registrationId);
  }

  async hideSession(registrationId: string, nativeSessionId: string): Promise<void> {
    const snapshot = this.snapshot(registrationId);
    if (!snapshot.sessions.some((session) => session.nativeSessionId === nativeSessionId)) return;
    this.snapshots.set(registrationId, {
      ...snapshot,
      sessions: snapshot.sessions.filter((session) => session.nativeSessionId !== nativeSessionId),
    });
  }

  isDraining(registrationId: string): boolean {
    this.snapshot(registrationId);
    return this.draining.has(registrationId);
  }

  async detach(registrationId: string): Promise<void> {
    if (!this.snapshots.delete(registrationId)) throw new Error(`Projection overlay not found: ${registrationId}`);
    this.draining.delete(registrationId);
  }

  list(registrationId: string): readonly string[] {
    return this.snapshot(registrationId).sessions.map((session) => session.nativeSessionId).sort();
  }

  inspect(registrationId: string, nativeSessionId: string): JsonValue | undefined {
    return this.snapshot(registrationId).sessions.find((session) => session.nativeSessionId === nativeSessionId)?.payload;
  }

  private snapshot(registrationId: string): ProjectionRuntimeSnapshot {
    const snapshot = this.snapshots.get(registrationId);
    if (snapshot === undefined) throw new Error(`Projection overlay not found: ${registrationId}`);
    return snapshot;
  }
}

export function normalizeProjectionRuntimeDescriptor(input: ProjectionRuntimeDescriptor): ProjectionRuntimeDescriptor {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.runId)) {
    throw new TypeError("runId must be an opaque ID, not a path");
  }
  const endpoint = new URL(input.maintenanceEndpoint);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new TypeError("maintenanceEndpoint must be a loopback HTTP endpoint");
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0 || endpoint.pathname !== "/" || endpoint.search.length > 0 || endpoint.hash.length > 0) {
    throw new TypeError("maintenanceEndpoint must be an origin without credentials or a projection path");
  }
  return { runId: input.runId, maintenanceEndpoint: endpoint.origin };
}

export class HttpProjectionRuntimeTransport implements ProjectionRuntimeTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly authorization: (() => Promise<string | undefined>) | undefined;

  constructor(
    fetchImpl: typeof fetch = fetch,
    authorization?: () => Promise<string | undefined>,
  ) {
    this.fetchImpl = fetchImpl;
    this.authorization = authorization;
  }

  async load(input: ProjectionRuntimeDescriptor): Promise<ProjectionRuntimeSnapshot> {
    const descriptor = normalizeProjectionRuntimeDescriptor(input);
    const authorization = await this.authorization?.();
    const response = await this.fetchImpl(
      `${descriptor.maintenanceEndpoint}/v1/projection-runs/${encodeURIComponent(descriptor.runId)}/runtime`,
      {
        headers: {
          accept: "application/json",
          ...(authorization === undefined ? {} : { authorization }),
        },
      },
    );
    if (!response.ok) throw new Error(`Maintenance projection runtime returned HTTP ${response.status}`);
    const snapshot = await response.json() as ProjectionRuntimeSnapshot;
    if (snapshot.schemaVersion !== 1 || snapshot.runId !== descriptor.runId || !Array.isArray(snapshot.sessions)) {
      throw new TypeError("Maintenance projection runtime returned an invalid snapshot");
    }
    return snapshot;
  }
}

export class ProjectionRuntimeRegistrar {
  readonly transport: ProjectionRuntimeTransport;
  readonly overlay: ProjectionPersistenceOverlay;
  private readonly registrations = new Map<string, string>();
  private readonly snapshots = new Map<string, ProjectionRuntimeSnapshot>();
  private readonly clock: () => string;

  constructor(input: {
    readonly transport: ProjectionRuntimeTransport;
    readonly overlay: ProjectionPersistenceOverlay;
    readonly clock?: () => string;
  }) {
    this.transport = input.transport;
    this.overlay = input.overlay;
    this.clock = input.clock ?? (() => new Date().toISOString());
  }

  async attach(input: ProjectionRuntimeDescriptor): Promise<{ readonly registrationId: string; readonly attachedAt: string }> {
    const descriptor = normalizeProjectionRuntimeDescriptor(input);
    if (this.registrations.has(descriptor.runId)) throw new Error(`Projection runtime already attached: ${descriptor.runId}`);
    const snapshot = await this.transport.load(descriptor);
    const registrationId = await this.overlay.attach(snapshot);
    this.registrations.set(descriptor.runId, registrationId);
    this.snapshots.set(descriptor.runId, snapshot);
    return { registrationId, attachedAt: this.clock() };
  }

  async drain(registrationId: string, runId: string): Promise<{ readonly runId: string; readonly pendingOperations: number; readonly receipts: readonly [] }> {
    this.assertRegistration(runId, registrationId);
    await this.overlay.beginDrain(registrationId);
    return { runId, pendingOperations: await this.overlay.pending(registrationId), receipts: [] };
  }

  async drainSession(registrationId: string, runId: string, _nativeSessionId: string): Promise<{ readonly runId: string; readonly pendingOperations: number; readonly receipts: readonly [] }> {
    this.assertRegistration(runId, registrationId);
    return { runId, pendingOperations: await this.overlay.pending(registrationId), receipts: [] };
  }

  async detach(registrationId: string, runId: string): Promise<void> {
    this.assertRegistration(runId, registrationId);
    await this.overlay.detach(registrationId);
    this.registrations.delete(runId);
    this.snapshots.delete(runId);
  }

  async hideSession(registrationId: string, runId: string, nativeSessionId: string): Promise<void> {
    this.assertRegistration(runId, registrationId);
    await this.overlay.hideSession(registrationId, nativeSessionId);
  }

  session(runId: string, nativeSessionId: string): ProjectionRuntimeSnapshot["sessions"][number] | undefined {
    return this.snapshots.get(runId)?.sessions.find((session) => session.nativeSessionId === nativeSessionId);
  }

  private assertRegistration(runId: string, registrationId: string): void {
    if (this.registrations.get(runId) !== registrationId) {
      throw new Error(`Projection runtime registration mismatch: ${runId}`);
    }
  }
}

interface SessionPersistenceProjectionContext {
  readonly sessionPersistence: {
    create(header: { readonly version: number; readonly id: string; readonly createdAt: number; readonly cwd?: string }): Promise<void>;
    append(id: string, events: readonly JsonValue[]): Promise<void>;
    list(): Promise<readonly { readonly id: string }[]>;
  };
  readonly workspaceRegistry: {
    replaceHeaderIndex(headers: readonly { readonly id: string }[]): Promise<void>;
  };
}

function object(value: JsonValue, description: string): { readonly [key: string]: JsonValue } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${description} must be an object`);
  return value as { readonly [key: string]: JsonValue };
}

/** Writes only into the startup-patched per-run persistence backend. */
export class Alpha2SessionPersistenceProjection implements ProjectionPersistenceOverlay {
  private readonly context: SessionPersistenceProjectionContext;
  private readonly expectedRootId: string;
  private readonly snapshots = new Map<string, ProjectionRuntimeSnapshot>();
  private readonly draining = new Set<string>();

  constructor(context: SessionPersistenceProjectionContext, expectedRootId: string) {
    if (!/^projection:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(expectedRootId)) {
      throw new TypeError("A startup-attested temporary persistence root ID is required");
    }
    this.context = context;
    this.expectedRootId = expectedRootId;
  }

  async attach(snapshot: ProjectionRuntimeSnapshot): Promise<string> {
    const registrationId = `projection:${snapshot.runId}`;
    if (registrationId !== this.expectedRootId) throw new Error("Runtime snapshot does not match the startup-patched persistence root");
    if (this.snapshots.has(registrationId)) throw new Error(`Projection persistence is already attached: ${snapshot.runId}`);
    for (const item of snapshot.sessions) {
      const payload = object(item.payload, "Alpha2 projected session");
      const header = object(payload.header ?? null, "Alpha2 projected SessionHeader");
      if (header.id !== item.nativeSessionId || typeof header.version !== "number" || typeof header.createdAt !== "number") {
        throw new TypeError("Alpha2 projected SessionHeader does not match its native session ID");
      }
      if (!Array.isArray(payload.events)) throw new TypeError("Alpha2 projected session events must be an array");
      await this.context.sessionPersistence.create(header as never);
      if (payload.events.length > 0) await this.context.sessionPersistence.append(item.nativeSessionId, payload.events);
    }
    await this.context.workspaceRegistry.replaceHeaderIndex(await this.context.sessionPersistence.list());
    this.snapshots.set(registrationId, structuredClone(snapshot));
    return registrationId;
  }

  async beginDrain(registrationId: string): Promise<void> {
    this.snapshot(registrationId);
    this.draining.add(registrationId);
  }

  async pending(registrationId: string): Promise<number> {
    this.snapshot(registrationId);
    return 0;
  }

  async hideSession(_registrationId: string, _nativeSessionId: string): Promise<void> {
    throw new Error("Alpha2 temporary persistence has no in-process delete; hide is broker-controlled");
  }

  async detach(registrationId: string): Promise<void> {
    this.snapshot(registrationId);
    this.snapshots.delete(registrationId);
    this.draining.delete(registrationId);
  }

  private snapshot(registrationId: string): ProjectionRuntimeSnapshot {
    const snapshot = this.snapshots.get(registrationId);
    if (snapshot === undefined) throw new Error(`Projection persistence is not attached: ${registrationId}`);
    return snapshot;
  }
}

interface ProjectedSessionMetadata {
  readonly logicalSessionId: string;
  readonly baseVersionId: string | null;
}

interface QueuedRuntimeEvent {
  readonly event: JsonValue;
  readonly header: JsonValue;
  readonly initialPrefix: readonly JsonValue[];
}

function projectedMetadata(value: JsonValue): ProjectedSessionMetadata {
  const payload = object(value, "Alpha2 projected session");
  if (typeof payload.logicalSessionId !== "string") throw new TypeError("Projected session lacks logicalSessionId");
  if (payload.baseVersionId !== null && typeof payload.baseVersionId !== "string") throw new TypeError("Projected session has invalid baseVersionId");
  return { logicalSessionId: payload.logicalSessionId, baseVersionId: payload.baseVersionId as string | null };
}

export class RuntimeBrokerPluginClient {
  private readonly connection: EngineConnectionProvider;
  private readonly registrar: ProjectionRuntimeRegistrar;
  private readonly clientId: string;
  private readonly runId: string;
  private readonly temporaryPersistenceRootId: string;
  private readonly endpoint: string;
  private readonly clock: () => string;
  private readonly fetchImpl: typeof fetch;
  private registrationId: string | null = null;
  private draining = false;
  private readonly tails = new Map<string, Promise<void>>();
  private readonly queues = new Map<string, QueuedRuntimeEvent[]>();
  private readonly failures = new Map<string, unknown>();
  private readonly dynamicMetadata = new Map<string, ProjectedSessionMetadata>();
  private readonly observedDynamicSessions = new Set<string>();

  constructor(input: {
    readonly connection: EngineConnectionProvider;
    readonly registrar: ProjectionRuntimeRegistrar;
    readonly clientId: string;
    readonly runId: string;
    readonly temporaryPersistenceRootId: string;
    readonly maintenanceEndpoint: string;
    readonly clock?: () => string;
    readonly fetchImpl?: typeof fetch;
  }) {
    this.connection = input.connection;
    this.registrar = input.registrar;
    this.clientId = input.clientId;
    this.runId = input.runId;
    this.temporaryPersistenceRootId = input.temporaryPersistenceRootId;
    this.endpoint = normalizeProjectionRuntimeDescriptor({ runId: input.runId, maintenanceEndpoint: input.maintenanceEndpoint }).maintenanceEndpoint;
    this.clock = input.clock ?? (() => new Date().toISOString());
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  async attach(): Promise<void> {
    const registration = await this.registrar.attach({ runId: this.runId, maintenanceEndpoint: this.endpoint });
    this.registrationId = registration.registrationId;
    const body: RuntimeBrokerAttachRunRequest = {
      schemaVersion: 1,
      clientId: this.clientId,
      runId: this.runId as never,
      temporaryPersistenceRootId: this.temporaryPersistenceRootId,
      attachedAt: registration.attachedAt,
    };
    await this.post(`/v1/runtime-broker/runs/${encodeURIComponent(this.runId)}/attach`, body);
  }

  observe(nativeSessionId: string, event: JsonValue, header: JsonValue, eventPrefix: readonly JsonValue[]): void {
    if (this.registrationId === null || this.draining) return;
    const projected = this.registrar.session(this.runId, nativeSessionId);
    const firstDynamicEvent = projected === undefined
      && !this.dynamicMetadata.has(nativeSessionId)
      && !this.observedDynamicSessions.has(nativeSessionId);
    if (firstDynamicEvent) this.observedDynamicSessions.add(nativeSessionId);
    const queue = this.queues.get(nativeSessionId) ?? [];
    queue.push({
      event,
      header,
      initialPrefix: firstDynamicEvent ? eventPrefix : [event],
    });
    this.queues.set(nativeSessionId, queue);
    this.schedule(nativeSessionId);
  }

  async flush(nativeSessionId: string): Promise<void> {
    this.schedule(nativeSessionId);
    let tail = this.tails.get(nativeSessionId);
    if (tail !== undefined) await tail;
    if ((this.queues.get(nativeSessionId)?.length ?? 0) > 0) {
      this.failures.delete(nativeSessionId);
      this.schedule(nativeSessionId);
      tail = this.tails.get(nativeSessionId);
      if (tail !== undefined) await tail;
    }
    const failure = this.failures.get(nativeSessionId);
    if (failure !== undefined) throw failure;
    const body: RuntimeBrokerFlushRequest = {
      schemaVersion: 1,
      clientId: this.clientId,
      runId: this.runId as never,
      nativeSessionId: nativeSessionId as NativeSessionId,
    };
    await this.post(`/v1/runtime-broker/runs/${encodeURIComponent(this.runId)}/flush`, body);
  }

  async drain(runtimeFlushCompletedAt: string): Promise<void> {
    if (this.registrationId === null) return;
    this.draining = true;
    for (const nativeSessionId of new Set([...this.tails.keys(), ...this.queues.keys()])) await this.flush(nativeSessionId);
    const body = {
      schemaVersion: 1,
      clientId: this.clientId,
      runId: this.runId as never,
      runtimeFlushCompletedAt,
    } as const;
    await this.post(`/v1/runtime-broker/runs/${encodeURIComponent(this.runId)}/drain`, body);
    await this.registrar.detach(this.registrationId, this.runId);
    this.registrationId = null;
  }

  private schedule(nativeSessionId: string): void {
    if (this.tails.has(nativeSessionId)) return;
    const request = (async () => {
      const queue = this.queues.get(nativeSessionId);
      while ((queue?.length ?? 0) > 0) {
        const queued = queue![0]!;
        try {
          const metadata = await this.metadata(nativeSessionId, queued.header);
          const envelope = object(queued.event, "Alpha2 session/event");
          if (!Number.isSafeInteger(envelope.seq)) throw new TypeError("Alpha2 session/event lacks a safe seq");
          const operation: NativeAppendOperation = {
            runId: this.runId as never,
            operationId: `${this.runId}:${nativeSessionId}:${String(envelope.seq)}` as never,
            nativeSessionId: nativeSessionId as NativeSessionId,
            nativeRevision: Number(envelope.seq) + 1,
            payload: {
              logicalSessionId: metadata.logicalSessionId,
              baseVersionId: metadata.baseVersionId,
              events: queued.initialPrefix,
            },
            observedAt: this.clock(),
          };
          await this.post(`/v1/runtime-broker/runs/${encodeURIComponent(this.runId)}/append`, {
            schemaVersion: 1,
            clientId: this.clientId,
            operation,
          });
          queue!.shift();
          this.failures.delete(nativeSessionId);
        } catch (error) {
          this.failures.set(nativeSessionId, error);
          break;
        }
      }
      if (queue?.length === 0) this.queues.delete(nativeSessionId);
    })();
    this.tails.set(nativeSessionId, request);
    void request.finally(() => {
      if (this.tails.get(nativeSessionId) === request) this.tails.delete(nativeSessionId);
    });
  }

  private async metadata(nativeSessionId: string, header: JsonValue): Promise<ProjectedSessionMetadata> {
    const projected = this.registrar.session(this.runId, nativeSessionId);
    if (projected !== undefined) return projectedMetadata(projected.payload);
    const existing = this.dynamicMetadata.get(nativeSessionId);
    if (existing !== undefined) return existing;
    const response = await this.post(`/v1/runtime-broker/runs/${encodeURIComponent(this.runId)}/sessions`, {
      schemaVersion: 1,
      clientId: this.clientId,
      runId: this.runId,
      nativeSessionId,
      header,
      title: `DSH session ${nativeSessionId}`,
    }) as { readonly session?: { readonly logicalSessionId?: unknown; readonly baseVersionId?: unknown } };
    if (typeof response.session?.logicalSessionId !== "string" || response.session.baseVersionId !== null) {
      throw new TypeError("Runtime Broker returned an invalid new-session registration");
    }
    const metadata = { logicalSessionId: response.session.logicalSessionId, baseVersionId: null };
    this.dynamicMetadata.set(nativeSessionId, metadata);
    return metadata;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const connection = await this.connection.current();
    if (connection.origin !== this.endpoint) throw new Error("Runtime Broker endpoint does not match the trusted Engine descriptor");
    const response = await this.fetchImpl(`${connection.origin}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        origin: connection.origin,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const value = await response.json().catch(() => ({})) as { readonly error?: { readonly message?: string } };
    if (!response.ok) throw new Error(value.error?.message ?? `Runtime Broker returned HTTP ${response.status}`);
    return value;
  }
}
