import type { JsonValue } from "@linmu/dsh-session-contracts";

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
  pending(registrationId: string): Promise<number>;
  detach(registrationId: string): Promise<void>;
}

export class Alpha2ProjectionPersistenceOverlay implements ProjectionPersistenceOverlay {
  private readonly snapshots = new Map<string, ProjectionRuntimeSnapshot>();

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

  async detach(registrationId: string): Promise<void> {
    if (!this.snapshots.delete(registrationId)) throw new Error(`Projection overlay not found: ${registrationId}`);
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
    return { registrationId, attachedAt: this.clock() };
  }

  async drain(registrationId: string, runId: string): Promise<{ readonly runId: string; readonly pendingOperations: number; readonly receipts: readonly [] }> {
    this.assertRegistration(runId, registrationId);
    return { runId, pendingOperations: await this.overlay.pending(registrationId), receipts: [] };
  }

  async detach(registrationId: string, runId: string): Promise<void> {
    this.assertRegistration(runId, registrationId);
    await this.overlay.detach(registrationId);
    this.registrations.delete(runId);
  }

  private assertRegistration(runId: string, registrationId: string): void {
    if (this.registrations.get(runId) !== registrationId) {
      throw new Error(`Projection runtime registration mismatch: ${runId}`);
    }
  }
}
