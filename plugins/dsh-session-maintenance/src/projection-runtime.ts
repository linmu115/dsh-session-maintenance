import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  RUNTIME_MANAGED_PROJECT_DIRECTORY,
  runtimeManagedProjectSegment,
} from "@linmu/dsh-session-contracts";
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

export interface ProjectionRuntimeSessionMetadata {
  readonly nativeSessionId: string;
  readonly updatedAt: string;
  readonly hot: boolean;
  readonly eventCount: number;
  /** Projected payload metadata. `events` is absent or empty in the catalog. */
  readonly payload: JsonValue;
}

export interface ProjectionRuntimeCatalog {
  readonly type: "catalog";
  readonly schemaVersion: 2;
  readonly runId: string;
  readonly hotLimit: number;
  readonly sessions: readonly ProjectionRuntimeSessionMetadata[];
}

export type ProjectionRuntimeCatalogTransferFrame = {
  readonly type: "catalog-begin";
  readonly schemaVersion: 2;
  readonly runId: string;
  readonly hotLimit: number;
  readonly sessionCount: number;
} | {
  readonly type: "catalog-sessions";
  readonly sessions: readonly ProjectionRuntimeSessionMetadata[];
} | {
  readonly type: "catalog-end";
  readonly sessionCount: number;
};

export type ProjectionRuntimeSessionFrame = {
  readonly type: "session-begin";
  readonly nativeSessionId: string;
} | {
  readonly type: "events";
  readonly nativeSessionId: string;
  readonly events: readonly JsonValue[];
} | {
  readonly type: "session-end";
  readonly nativeSessionId: string;
  readonly eventCount: number;
};

export type ProjectionRuntimeFrame = ProjectionRuntimeCatalogTransferFrame | ProjectionRuntimeSessionFrame;

export interface ProjectionRuntimeTransport {
  stream(input: ProjectionRuntimeDescriptor, nativeSessionId?: string): AsyncIterable<ProjectionRuntimeFrame>;
}

export interface ProjectionPersistenceOverlay {
  attach(catalog: ProjectionRuntimeCatalog): Promise<string>;
  beginHydration(registrationId: string, session: ProjectionRuntimeSessionMetadata): Promise<void>;
  appendHydrationEvents(registrationId: string, nativeSessionId: string, events: readonly JsonValue[]): Promise<void>;
  finishHydration(registrationId: string, nativeSessionId: string, eventCount: number): Promise<void>;
  isHydrated(registrationId: string, nativeSessionId: string): boolean;
  listHeaders(registrationId: string): readonly JsonValue[];
  beginDrain(registrationId: string): Promise<void>;
  pending(registrationId: string): Promise<number>;
  hideSession(registrationId: string, nativeSessionId: string): Promise<void>;
  detach(registrationId: string): Promise<void>;
}

export class Alpha2ProjectionPersistenceOverlay implements ProjectionPersistenceOverlay {
  private readonly catalogs = new Map<string, ProjectionRuntimeCatalog>();
  private readonly hydrated = new Map<string, Set<string>>();
  private readonly counts = new Map<string, Map<string, number>>();
  private readonly draining = new Set<string>();

  async attach(catalog: ProjectionRuntimeCatalog): Promise<string> {
    const registrationId = `projection:${catalog.runId}`;
    if (this.catalogs.has(registrationId)) throw new Error(`Projection overlay already exists: ${catalog.runId}`);
    this.catalogs.set(registrationId, structuredClone(catalog));
    this.hydrated.set(registrationId, new Set());
    this.counts.set(registrationId, new Map());
    return registrationId;
  }

  async beginHydration(registrationId: string, session: ProjectionRuntimeSessionMetadata): Promise<void> {
    this.catalog(registrationId);
    this.counts.get(registrationId)!.set(session.nativeSessionId, 0);
  }

  async appendHydrationEvents(registrationId: string, nativeSessionId: string, events: readonly JsonValue[]): Promise<void> {
    const counts = this.countsFor(registrationId);
    counts.set(nativeSessionId, (counts.get(nativeSessionId) ?? 0) + events.length);
  }

  async finishHydration(registrationId: string, nativeSessionId: string, eventCount: number): Promise<void> {
    if (this.countsFor(registrationId).get(nativeSessionId) !== eventCount) throw new Error("Projection stream event count mismatch");
    this.hydrated.get(registrationId)!.add(nativeSessionId);
  }

  isHydrated(registrationId: string, nativeSessionId: string): boolean {
    this.catalog(registrationId);
    return this.hydrated.get(registrationId)!.has(nativeSessionId);
  }

  listHeaders(registrationId: string): readonly JsonValue[] {
    return this.catalog(registrationId).sessions.map((session) => {
      const payload = object(session.payload, "projected session");
      return structuredClone(payload.header ?? null);
    });
  }

  async pending(registrationId: string): Promise<number> {
    this.catalog(registrationId);
    return 0;
  }

  async beginDrain(registrationId: string): Promise<void> {
    this.catalog(registrationId);
    this.draining.add(registrationId);
  }

  async hideSession(registrationId: string, nativeSessionId: string): Promise<void> {
    const catalog = this.catalog(registrationId);
    if (!catalog.sessions.some((session) => session.nativeSessionId === nativeSessionId)) return;
    this.catalogs.set(registrationId, {
      ...catalog,
      sessions: catalog.sessions.filter((session) => session.nativeSessionId !== nativeSessionId),
    });
    this.hydrated.get(registrationId)?.delete(nativeSessionId);
  }

  isDraining(registrationId: string): boolean {
    this.catalog(registrationId);
    return this.draining.has(registrationId);
  }

  async detach(registrationId: string): Promise<void> {
    if (!this.catalogs.delete(registrationId)) throw new Error(`Projection overlay not found: ${registrationId}`);
    this.hydrated.delete(registrationId);
    this.counts.delete(registrationId);
    this.draining.delete(registrationId);
  }

  list(registrationId: string): readonly string[] {
    return this.catalog(registrationId).sessions.map((session) => session.nativeSessionId).sort();
  }

  inspect(registrationId: string, nativeSessionId: string): JsonValue | undefined {
    return this.catalog(registrationId).sessions.find((session) => session.nativeSessionId === nativeSessionId)?.payload;
  }

  private catalog(registrationId: string): ProjectionRuntimeCatalog {
    const catalog = this.catalogs.get(registrationId);
    if (catalog === undefined) throw new Error(`Projection overlay not found: ${registrationId}`);
    return catalog;
  }

  private countsFor(registrationId: string): Map<string, number> {
    this.catalog(registrationId);
    return this.counts.get(registrationId)!;
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

  async *stream(input: ProjectionRuntimeDescriptor, nativeSessionId?: string): AsyncIterable<ProjectionRuntimeFrame> {
    const descriptor = normalizeProjectionRuntimeDescriptor(input);
    const authorization = await this.authorization?.();
    const path = nativeSessionId === undefined
      ? `/v1/projection-runs/${encodeURIComponent(descriptor.runId)}/runtime/stream?hotLimit=200`
      : `/v1/projection-runs/${encodeURIComponent(descriptor.runId)}/runtime/sessions/${encodeURIComponent(nativeSessionId)}/stream`;
    const response = await this.fetchImpl(
      `${descriptor.maintenanceEndpoint}${path}`,
      {
        headers: {
          accept: "application/x-ndjson",
          ...(authorization === undefined ? {} : { authorization }),
        },
      },
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let message = `Maintenance projection runtime returned HTTP ${response.status}`;
      try { message = (JSON.parse(text) as { readonly error?: { readonly message?: string } }).error?.message ?? message; } catch { /* bounded status fallback */ }
      throw new Error(message.slice(0, 500));
    }
    if (response.body === null) throw new Error("Maintenance projection runtime returned no stream body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let first = true;
    try {
      while (true) {
        const chunk = await reader.read();
        buffered += decoder.decode(chunk.value, { stream: !chunk.done });
        if (buffered.length > 16 * 1024 * 1024 && !buffered.includes("\n")) {
          throw new TypeError("Projection stream frame exceeds the 16 MiB safety limit");
        }
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line.length > 0) {
            const frame = validateRuntimeFrame(JSON.parse(line), descriptor.runId, first && nativeSessionId === undefined);
            first = false;
            yield frame;
          }
          newline = buffered.indexOf("\n");
        }
        if (chunk.done) break;
      }
      if (buffered.trim().length > 0) {
        yield validateRuntimeFrame(JSON.parse(buffered), descriptor.runId, first && nativeSessionId === undefined);
        first = false;
      }
      if (first) throw new TypeError("Maintenance projection runtime returned an empty stream");
    } finally {
      reader.releaseLock();
    }
  }
}

function validateRuntimeFrame(value: unknown, runId: string, requireCatalogBegin: boolean): ProjectionRuntimeFrame {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Projection stream frame must be an object");
  const frame = value as Record<string, unknown>;
  if (requireCatalogBegin) {
    if (frame.type !== "catalog-begin" || frame.schemaVersion !== 2 || frame.runId !== runId
      || !Number.isSafeInteger(frame.hotLimit) || Number(frame.hotLimit) < 0
      || !Number.isSafeInteger(frame.sessionCount) || Number(frame.sessionCount) < 0) {
      throw new TypeError("Projection stream must begin with catalog-begin");
    }
    return value as ProjectionRuntimeCatalogTransferFrame;
  }
  if (frame.type === "catalog-begin") {
    if (frame.schemaVersion !== 2 || frame.runId !== runId
      || !Number.isSafeInteger(frame.hotLimit) || Number(frame.hotLimit) < 0
      || !Number.isSafeInteger(frame.sessionCount) || Number(frame.sessionCount) < 0) {
      throw new TypeError("Projection stream catalog begin is invalid");
    }
    return value as ProjectionRuntimeCatalogTransferFrame;
  }
  if (frame.type === "catalog-sessions") {
    if (!Array.isArray(frame.sessions)) throw new TypeError("Projection stream catalog chunk is invalid");
    return value as ProjectionRuntimeCatalogTransferFrame;
  }
  if (frame.type === "catalog-end") {
    if (!Number.isSafeInteger(frame.sessionCount) || Number(frame.sessionCount) < 0) {
      throw new TypeError("Projection stream catalog end is invalid");
    }
    return value as ProjectionRuntimeCatalogTransferFrame;
  }
  if (!["session-begin", "events", "session-end"].includes(String(frame.type)) || typeof frame.nativeSessionId !== "string") {
    throw new TypeError("Projection stream session frame is invalid");
  }
  if (frame.type === "events" && !Array.isArray(frame.events)) throw new TypeError("Projection stream event chunk is invalid");
  if (frame.type === "session-end" && (!Number.isSafeInteger(frame.eventCount) || Number(frame.eventCount) < 0)) {
    throw new TypeError("Projection stream session end is invalid");
  }
  return value as ProjectionRuntimeFrame;
}

export class ProjectionRuntimeRegistrar {
  readonly transport: ProjectionRuntimeTransport;
  readonly overlay: ProjectionPersistenceOverlay;
  private readonly registrations = new Map<string, string>();
  private readonly catalogs = new Map<string, ProjectionRuntimeCatalog>();
  private readonly hydrationTails = new Map<string, Promise<void>>();
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
    let catalogBegin: Extract<ProjectionRuntimeCatalogTransferFrame, { readonly type: "catalog-begin" }> | undefined;
    const catalogSessions: ProjectionRuntimeSessionMetadata[] = [];
    let catalog: ProjectionRuntimeCatalog | undefined;
    let registrationId: string | undefined;
    const open = new Set<string>();
    for await (const frame of this.transport.stream(descriptor)) {
      if (frame.type === "catalog-begin") {
        if (catalogBegin !== undefined || catalog !== undefined) throw new TypeError("Projection startup stream returned more than one catalog begin");
        catalogBegin = frame;
        continue;
      }
      if (frame.type === "catalog-sessions") {
        if (catalogBegin === undefined || catalog !== undefined) throw new TypeError("Projection catalog chunk arrived outside its catalog boundary");
        catalogSessions.push(...frame.sessions);
        if (catalogSessions.length > catalogBegin.sessionCount) throw new TypeError("Projection catalog exceeded its declared session count");
        continue;
      }
      if (frame.type === "catalog-end") {
        if (catalogBegin === undefined || catalog !== undefined
          || frame.sessionCount !== catalogBegin.sessionCount
          || catalogSessions.length !== frame.sessionCount) {
          throw new TypeError("Projection catalog ended with an invalid session count");
        }
        catalog = validateCatalog({
          type: "catalog",
          schemaVersion: 2,
          runId: catalogBegin.runId,
          hotLimit: catalogBegin.hotLimit,
          sessions: catalogSessions,
        }, descriptor.runId);
        registrationId = await this.overlay.attach(catalog);
        continue;
      }
      if (catalog === undefined || registrationId === undefined) throw new TypeError("Projection startup stream omitted its catalog");
      await this.consumeSessionFrame(registrationId, catalog, frame, open);
    }
    if (catalog === undefined || registrationId === undefined) throw new TypeError("Projection startup stream omitted its catalog");
    if (open.size > 0) throw new TypeError("Projection startup stream ended inside a session");
    this.registrations.set(descriptor.runId, registrationId);
    this.catalogs.set(descriptor.runId, catalog);
    return { registrationId, attachedAt: this.clock() };
  }

  async hydrate(input: ProjectionRuntimeDescriptor, nativeSessionId: string): Promise<void> {
    const descriptor = normalizeProjectionRuntimeDescriptor(input);
    const registrationId = this.registrations.get(descriptor.runId);
    const catalog = this.catalogs.get(descriptor.runId);
    if (registrationId === undefined || catalog === undefined) throw new Error(`Projection runtime is not attached: ${descriptor.runId}`);
    const session = catalog.sessions.find((item) => item.nativeSessionId === nativeSessionId);
    if (session === undefined) throw new Error(`Projection session is not in the catalog: ${nativeSessionId}`);
    if (this.overlay.isHydrated(registrationId, nativeSessionId)) return;
    const key = `${descriptor.runId}\u0000${nativeSessionId}`;
    const existing = this.hydrationTails.get(key);
    if (existing !== undefined) return existing;
    const hydration = (async () => {
      const open = new Set<string>();
      for await (const frame of this.transport.stream(descriptor, nativeSessionId)) {
        if (frame.type === "catalog-begin" || frame.type === "catalog-sessions" || frame.type === "catalog-end") {
          throw new TypeError("Single-session projection stream returned a catalog frame");
        }
        if (frame.nativeSessionId !== nativeSessionId) throw new TypeError("Single-session projection stream changed session identity");
        await this.consumeSessionFrame(registrationId, catalog, frame, open);
      }
      if (open.size > 0 || !this.overlay.isHydrated(registrationId, nativeSessionId)) {
        throw new TypeError("Single-session projection stream ended before hydration completed");
      }
    })().finally(() => this.hydrationTails.delete(key));
    this.hydrationTails.set(key, hydration);
    return hydration;
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
    this.catalogs.delete(runId);
  }

  async hideSession(registrationId: string, runId: string, nativeSessionId: string): Promise<void> {
    this.assertRegistration(runId, registrationId);
    await this.overlay.hideSession(registrationId, nativeSessionId);
  }

  session(runId: string, nativeSessionId: string): ProjectionRuntimeSessionMetadata | undefined {
    return this.catalogs.get(runId)?.sessions.find((session) => session.nativeSessionId === nativeSessionId);
  }

  coldSessionIds(runId: string): readonly string[] {
    const registrationId = this.registrations.get(runId);
    const catalog = this.catalogs.get(runId);
    if (registrationId === undefined || catalog === undefined) return [];
    return catalog.sessions.filter((session) => !this.overlay.isHydrated(registrationId, session.nativeSessionId))
      .map((session) => session.nativeSessionId);
  }

  sessionHeaders(runId: string): readonly JsonValue[] {
    const registrationId = this.registrations.get(runId);
    if (registrationId === undefined) return [];
    return this.overlay.listHeaders(registrationId);
  }

  private async consumeSessionFrame(
    registrationId: string,
    catalog: ProjectionRuntimeCatalog,
    frame: ProjectionRuntimeSessionFrame,
    open: Set<string>,
  ): Promise<void> {
    const session = catalog.sessions.find((item) => item.nativeSessionId === frame.nativeSessionId);
    if (session === undefined) throw new TypeError(`Projection stream addressed an unknown session: ${frame.nativeSessionId}`);
    if (frame.type === "session-begin") {
      if (open.has(frame.nativeSessionId)) throw new TypeError("Projection stream began the same session twice");
      open.add(frame.nativeSessionId);
      await this.overlay.beginHydration(registrationId, session);
    } else if (frame.type === "events") {
      if (!open.has(frame.nativeSessionId)) throw new TypeError("Projection event chunk arrived outside a session");
      await this.overlay.appendHydrationEvents(registrationId, frame.nativeSessionId, frame.events);
    } else {
      if (!open.delete(frame.nativeSessionId)) throw new TypeError("Projection session ended without beginning");
      if (frame.eventCount !== session.eventCount) throw new TypeError("Projection catalog and session event counts differ");
      await this.overlay.finishHydration(registrationId, frame.nativeSessionId, frame.eventCount);
    }
  }

  private assertRegistration(runId: string, registrationId: string): void {
    if (this.registrations.get(runId) !== registrationId) {
      throw new Error(`Projection runtime registration mismatch: ${runId}`);
    }
  }
}

function validateCatalog(catalog: ProjectionRuntimeCatalog, runId: string): ProjectionRuntimeCatalog {
  if (catalog.schemaVersion !== 2 || catalog.runId !== runId || !Number.isSafeInteger(catalog.hotLimit) || catalog.hotLimit < 0) {
    throw new TypeError("Projection runtime catalog is invalid");
  }
  const ids = new Set<string>();
  for (const session of catalog.sessions) {
    if (typeof session.nativeSessionId !== "string" || !/^[a-zA-Z0-9_-]+$/u.test(session.nativeSessionId)
      || ids.has(session.nativeSessionId)
      || typeof session.updatedAt !== "string" || typeof session.hot !== "boolean"
      || !Number.isSafeInteger(session.eventCount) || session.eventCount < 0) {
      throw new TypeError("Projection runtime catalog session is invalid");
    }
    ids.add(session.nativeSessionId);
  }
  return catalog;
}

interface SessionPersistenceProjectionContext {
  readonly sessionPersistence: {
    readonly root?: string;
    create(header: { readonly version: number; readonly id: string; readonly createdAt: number; readonly delegationDepth: number; readonly cwd?: string }): Promise<void>;
    append(id: string, events: readonly JsonValue[]): Promise<void>;
    list(): Promise<readonly { readonly id: string }[]>;
  };
  readonly workspaceRegistry: {
    replaceHeaderIndex(headers: readonly { readonly id: string }[]): Promise<void>;
    list(): readonly {
      readonly id: string;
      readonly path: string;
      readonly title: string;
      setTitle(title: string): Promise<void>;
      attachSession(sessionId: string): Promise<void>;
    }[];
    create(path: string, title?: string): Promise<{
      readonly id: string;
      readonly path: string;
      readonly title: string;
      setTitle(title: string): Promise<void>;
      attachSession(sessionId: string): Promise<void>;
    }>;
    delete(id: string): Promise<boolean>;
  };
  readonly sessionProjectionCache: {
    readonly table: {
      get(id: string): unknown;
      put(id: string, value: unknown): Promise<void>;
    };
  };
}

export type ProjectionRuntimeStatusReporter = (
  stage: "runtime.workspace.index" | "runtime.workspace.reconcile" | "runtime.projection-cache.seed",
  detail: Readonly<Record<string, string | number>>,
) => void;

function object(value: JsonValue, description: string): { readonly [key: string]: JsonValue } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${description} must be an object`);
  return value as { readonly [key: string]: JsonValue };
}

/** Writes only into the startup-patched per-run persistence backend. */
export class Alpha2SessionPersistenceProjection implements ProjectionPersistenceOverlay {
  private readonly context: SessionPersistenceProjectionContext;
  private readonly expectedRootId: string;
  private readonly status: ProjectionRuntimeStatusReporter;
  private readonly catalogs = new Map<string, ProjectionRuntimeCatalog>();
  private readonly hydrated = new Map<string, Set<string>>();
  private readonly counts = new Map<string, Map<string, number>>();
  private readonly draining = new Set<string>();

  constructor(
    context: SessionPersistenceProjectionContext,
    expectedRootId: string,
    status: ProjectionRuntimeStatusReporter = () => undefined,
  ) {
    if (!/^projection:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(expectedRootId)) {
      throw new TypeError("A startup-attested temporary persistence root ID is required");
    }
    this.context = context;
    this.expectedRootId = expectedRootId;
    this.status = status;
  }

  async attach(catalog: ProjectionRuntimeCatalog): Promise<string> {
    const registrationId = `projection:${catalog.runId}`;
    if (registrationId !== this.expectedRootId) throw new Error("Runtime snapshot does not match the startup-patched persistence root");
    if (this.catalogs.has(registrationId)) throw new Error(`Projection persistence is already attached: ${catalog.runId}`);
    const headers: Array<{ readonly version: number; readonly id: string; readonly createdAt: number; readonly delegationDepth: number; readonly cwd?: string }> = [];
    const normalizedSessions: ProjectionRuntimeSessionMetadata[] = [];
    const workspaceGroups = new Map<string, { readonly title: string; readonly sessionIds: string[] }>();
    let managedCwds = 0;
    for (const item of catalog.sessions) {
      const payload = object(item.payload, "Alpha2 projected session");
      const projectedHeader = object(payload.header ?? null, "Alpha2 projected SessionHeader");
      if (projectedHeader.id !== item.nativeSessionId || typeof projectedHeader.version !== "number" || typeof projectedHeader.createdAt !== "number") {
        throw new TypeError("Alpha2 projected SessionHeader does not match its native session ID");
      }
      const { header, managed } = await this.runtimeHeader(projectedHeader, payload);
      if (managed) managedCwds += 1;
      headers.push(header);
      normalizedSessions.push({
        ...item,
        payload: { ...payload, header } as JsonValue,
      });
      const group = workspaceGroups.get(header.cwd);
      const title = this.projectTitle(payload, header.cwd);
      if (group === undefined) workspaceGroups.set(header.cwd, { title, sessionIds: [item.nativeSessionId] });
      else group.sessionIds.push(item.nativeSessionId);
    }
    // Workspace membership is indexed for every projected header here. The
    // SessionPersistence.list() decorator separately exposes cold headers to
    // SessionQuery without materializing their histories.
    await this.context.workspaceRegistry.replaceHeaderIndex(headers);
    this.status("runtime.workspace.index", {
      sessions: headers.length,
      projects: workspaceGroups.size,
      managedCwds,
    });
    let staleManagedWorkspaces = 0;
    let refreshedWorkspaces = 0;
    for (const workspace of this.context.workspaceRegistry.list()) {
      if (this.isManagedWorkspacePath(workspace.path) && !workspaceGroups.has(resolve(workspace.path))) {
        if (await this.context.workspaceRegistry.delete(workspace.id)) staleManagedWorkspaces += 1;
        continue;
      }
      // Alpha2 prunes stale membership only when a workspace record mutates.
      // Re-applying the same title therefore removes sessions whose canonical
      // cwd moved without guessing at the registry's private table format.
      await workspace.setTitle(workspace.title);
      refreshedWorkspaces += 1;
    }
    let attachedSessions = 0;
    let workspaceFailures = 0;
    let firstFailure = "";
    for (const [cwd, group] of workspaceGroups) {
      try {
        const workspace = await this.context.workspaceRegistry.create(cwd, group.title);
        if (workspace.title !== group.title) await workspace.setTitle(group.title);
        for (const sessionId of group.sessionIds) {
          await workspace.attachSession(sessionId);
          attachedSessions += 1;
        }
      } catch (error) {
        workspaceFailures += 1;
        if (firstFailure.length === 0) firstFailure = error instanceof Error ? error.message : String(error);
      }
    }
    this.status("runtime.workspace.reconcile", {
      projects: workspaceGroups.size,
      attachedSessions,
      failures: workspaceFailures,
      refreshedWorkspaces,
      staleManagedWorkspaces,
      ...(firstFailure.length > 0 ? { firstFailure } : {}),
    });
    let seededTitles = 0;
    let seededMetadata = 0;
    for (const item of normalizedSessions) {
      const seeded = await this.seedProjectionCache(item);
      seededTitles += seeded.title;
      seededMetadata += seeded.metadata;
    }
    this.status("runtime.projection-cache.seed", {
      sessions: normalizedSessions.length,
      titles: seededTitles,
      metadata: seededMetadata,
    });
    this.catalogs.set(registrationId, {
      ...catalog,
      sessions: normalizedSessions,
    });
    this.hydrated.set(registrationId, new Set());
    this.counts.set(registrationId, new Map());
    return registrationId;
  }

  async beginHydration(registrationId: string, session: ProjectionRuntimeSessionMetadata): Promise<void> {
    this.catalog(registrationId);
    if (this.isHydrated(registrationId, session.nativeSessionId)) return;
    const projected = this.catalog(registrationId).sessions.find((item) => item.nativeSessionId === session.nativeSessionId);
    if (projected === undefined) throw new Error(`Alpha2 projected session is not registered: ${session.nativeSessionId}`);
    const payload = object(projected.payload, "Alpha2 projected session");
    const header = object(payload.header ?? null, "Alpha2 projected SessionHeader");
    await this.context.sessionPersistence.create(header as never);
    this.counts.get(registrationId)!.set(session.nativeSessionId, 0);
  }

  async appendHydrationEvents(registrationId: string, nativeSessionId: string, events: readonly JsonValue[]): Promise<void> {
    if (events.length === 0) return;
    const counts = this.countsFor(registrationId);
    if (!counts.has(nativeSessionId)) throw new Error("Alpha2 hydration event chunk arrived before session begin");
    await this.context.sessionPersistence.append(nativeSessionId, events);
    counts.set(nativeSessionId, counts.get(nativeSessionId)! + events.length);
  }

  async finishHydration(registrationId: string, nativeSessionId: string, eventCount: number): Promise<void> {
    const count = this.countsFor(registrationId).get(nativeSessionId);
    if (count !== eventCount) throw new Error(`Alpha2 projected event count mismatch: ${String(count)} != ${eventCount}`);
    this.hydrated.get(registrationId)!.add(nativeSessionId);
  }

  isHydrated(registrationId: string, nativeSessionId: string): boolean {
    this.catalog(registrationId);
    return this.hydrated.get(registrationId)!.has(nativeSessionId);
  }

  listHeaders(registrationId: string): readonly JsonValue[] {
    return this.catalog(registrationId).sessions.map((session) => {
      const payload = object(session.payload, "Alpha2 projected session");
      return structuredClone(payload.header ?? null);
    });
  }

  async beginDrain(registrationId: string): Promise<void> {
    this.catalog(registrationId);
    this.draining.add(registrationId);
  }

  async pending(registrationId: string): Promise<number> {
    this.catalog(registrationId);
    return 0;
  }

  async hideSession(_registrationId: string, _nativeSessionId: string): Promise<void> {
    throw new Error("Alpha2 temporary persistence has no in-process delete; hide is broker-controlled");
  }

  async detach(registrationId: string): Promise<void> {
    this.catalog(registrationId);
    this.catalogs.delete(registrationId);
    this.hydrated.delete(registrationId);
    this.counts.delete(registrationId);
    this.draining.delete(registrationId);
  }

  private catalog(registrationId: string): ProjectionRuntimeCatalog {
    const catalog = this.catalogs.get(registrationId);
    if (catalog === undefined) throw new Error(`Projection persistence is not attached: ${registrationId}`);
    return catalog;
  }

  private countsFor(registrationId: string): Map<string, number> {
    this.catalog(registrationId);
    return this.counts.get(registrationId)!;
  }

  private async runtimeHeader(
    header: { readonly [key: string]: JsonValue },
    payload: { readonly [key: string]: JsonValue },
  ): Promise<{ readonly header: { readonly version: number; readonly id: string; readonly createdAt: number; readonly delegationDepth: number; readonly cwd: string }; readonly managed: boolean }> {
    const delegationDepth = header.delegationDepth === undefined ? 0 : Number(header.delegationDepth);
    if (!Number.isSafeInteger(delegationDepth) || delegationDepth < 0) {
      throw new TypeError("Alpha2 projected SessionHeader has an invalid delegationDepth");
    }
    const baseHeader = {
      version: Number(header.version),
      id: String(header.id),
      createdAt: Number(header.createdAt),
      delegationDepth,
    };
    const projectedCwd = typeof header.cwd === "string" && header.cwd.length > 0 ? header.cwd : null;
    if (projectedCwd !== null) {
      try {
        if ((await stat(projectedCwd)).isDirectory()) {
          return { header: { ...baseHeader, cwd: resolve(projectedCwd) }, managed: false };
        }
      } catch {
        // Missing or inaccessible canonical roots are represented by a run-scoped managed cwd below.
      }
    }
    const persistenceRoot = this.context.sessionPersistence.root;
    if (typeof persistenceRoot !== "string" || persistenceRoot.length === 0) {
      throw new Error("Alpha2 temporary persistence root is unavailable for a project-only cwd projection");
    }
    const projectId = typeof payload.projectId === "string" && payload.projectId.length > 0 ? payload.projectId : null;
    const cwd = join(
      resolve(persistenceRoot, ".."),
      RUNTIME_MANAGED_PROJECT_DIRECTORY,
      runtimeManagedProjectSegment(projectId),
    );
    await mkdir(cwd, { recursive: true });
    return { header: { ...baseHeader, cwd }, managed: true };
  }

  private projectTitle(payload: { readonly [key: string]: JsonValue }, cwd: string): string {
    if (typeof payload.projectTitle === "string" && payload.projectTitle.trim().length > 0) return payload.projectTitle.trim();
    if (typeof payload.projectId === "string" && payload.projectId.trim().length > 0) return payload.projectId.trim();
    const parts = cwd.replace(/[\\/]+$/u, "").split(/[\\/]/u);
    return parts.at(-1) || "未分类";
  }

  private isManagedWorkspacePath(path: string): boolean {
    const segments = resolve(path).split(/[\\/]+/u).map((segment) => segment.toLowerCase());
    const managed = RUNTIME_MANAGED_PROJECT_DIRECTORY.toLowerCase();
    return segments.some((segment, index) => segment === managed && index > 0 && segments[index - 1] === "projection");
  }

  private async seedProjectionCache(
    item: ProjectionRuntimeSessionMetadata,
  ): Promise<{ readonly title: 0 | 1; readonly metadata: 1 }> {
    const payload = object(item.payload, "Alpha2 projected session");
    const header = object(payload.header ?? null, "Alpha2 projected SessionHeader");
    const identity = {
      createdAt: Number(header.createdAt),
      ...(typeof header.cwd === "string" ? { cwd: header.cwd } : {}),
    };
    const current = this.context.sessionProjectionCache.table.get(item.nativeSessionId);
    const currentRecord = current !== null && typeof current === "object" && !Array.isArray(current)
      ? current as { readonly identity?: unknown; readonly rows?: unknown }
      : undefined;
    const currentIdentity = currentRecord?.identity !== null && typeof currentRecord?.identity === "object" && !Array.isArray(currentRecord.identity)
      ? currentRecord.identity as { readonly createdAt?: unknown; readonly cwd?: unknown }
      : undefined;
    const sameIdentity = currentIdentity?.createdAt === identity.createdAt && currentIdentity.cwd === identity.cwd;
    const rows = sameIdentity && currentRecord?.rows !== null && typeof currentRecord?.rows === "object" && !Array.isArray(currentRecord.rows)
      ? { ...(currentRecord.rows as Record<string, unknown>) }
      : {};
    const seq = item.eventCount - 1;
    const updatedAt = Date.parse(item.updatedAt);
    rows.sessionListMetadata = {
      ver: 1,
      seq,
      val: {
        blank: item.eventCount === 0,
        lastPromptAt: item.eventCount === 0 || !Number.isSafeInteger(updatedAt) ? null : updatedAt,
      },
    };
    const title = typeof payload.title === "string" && payload.title.trim().length > 0 ? payload.title.trim() : null;
    if (title !== null) rows.title = { ver: 1, seq, val: title };
    await this.context.sessionProjectionCache.table.put(item.nativeSessionId, { identity, rows });
    return { title: title === null ? 0 : 1, metadata: 1 };
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

interface PendingRuntimeBatch {
  readonly queueLength: number;
  readonly operation: NativeAppendOperation;
}

const DEFERRED_SESSION_PRELUDE_TYPES = new Set([
  "session/end-seed",
  "permission/preset",
  "sandbox/mode",
  "approval/policy",
]);

function isDeferredSessionPrelude(value: JsonValue): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { readonly type?: unknown }).type === "string"
    && DEFERRED_SESSION_PRELUDE_TYPES.has((value as { readonly type: string }).type);
}

function projectedMetadata(value: JsonValue): ProjectedSessionMetadata {
  const payload = object(value, "Alpha2 projected session");
  if (typeof payload.logicalSessionId !== "string") throw new TypeError("Projected session lacks logicalSessionId");
  if (payload.baseVersionId !== null && typeof payload.baseVersionId !== "string") throw new TypeError("Projected session has invalid baseVersionId");
  return { logicalSessionId: payload.logicalSessionId, baseVersionId: payload.baseVersionId as string | null };
}

function committedMetadata(value: unknown): ProjectedSessionMetadata | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const receipt = (value as { readonly receipt?: unknown }).receipt;
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) return undefined;
  const candidate = receipt as {
    readonly status?: unknown;
    readonly logicalSessionId?: unknown;
    readonly canonicalVersionId?: unknown;
  };
  if (candidate.status !== "committed" || typeof candidate.logicalSessionId !== "string") return undefined;
  if (candidate.canonicalVersionId !== null && typeof candidate.canonicalVersionId !== "string") return undefined;
  return {
    logicalSessionId: candidate.logicalSessionId,
    baseVersionId: candidate.canonicalVersionId,
  };
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
  private readonly pendingBatches = new Map<string, PendingRuntimeBatch>();
  private readonly failures = new Map<string, unknown>();
  private readonly dynamicMetadata = new Map<string, ProjectedSessionMetadata>();
  private readonly observedDynamicSessions = new Set<string>();
  private readonly observedRevisions = new Map<string, number>();
  private readonly deferredPrefixes = new Map<string, JsonValue[]>();
  private readonly activatedSessions = new Set<string>();

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

  coldSessionIds(): readonly string[] {
    return this.registrar.coldSessionIds(this.runId);
  }

  sessionHeaders(): readonly JsonValue[] {
    return this.registrar.sessionHeaders(this.runId);
  }

  async hydrate(nativeSessionId: string): Promise<void> {
    if (this.registrationId === null || this.draining) throw new Error("Projection runtime is not available for hydration");
    await this.registrar.hydrate({ runId: this.runId, maintenanceEndpoint: this.endpoint }, nativeSessionId);
  }

  observe(nativeSessionId: string, event: JsonValue, header: JsonValue, eventPrefix: readonly JsonValue[]): void {
    if (this.registrationId === null || this.draining) return;
    const projected = this.registrar.session(this.runId, nativeSessionId);
    const envelope = object(event, "Alpha2 session/event");
    if (!Number.isSafeInteger(envelope.seq) || Number(envelope.seq) < 0) {
      this.failures.set(nativeSessionId, new TypeError("Alpha2 session/event lacks a safe seq"));
      return;
    }
    const nextRevision = Number(envelope.seq) + 1;
    const currentRevision = this.observedRevisions.get(nativeSessionId) ?? projected?.eventCount ?? 0;
    if (nextRevision <= currentRevision) return;
    if (eventPrefix.length < nextRevision) {
      this.failures.set(nativeSessionId, new TypeError("Alpha2 session/event prefix is shorter than its revision"));
      return;
    }
    const missingTail = eventPrefix.slice(currentRevision, nextRevision);
    if (missingTail.length !== nextRevision - currentRevision) {
      this.failures.set(nativeSessionId, new TypeError("Alpha2 session/event prefix is not contiguous"));
      return;
    }
    this.observedRevisions.set(nativeSessionId, nextRevision);
    const firstDynamicEvent = projected === undefined
      && !this.dynamicMetadata.has(nativeSessionId)
      && !this.observedDynamicSessions.has(nativeSessionId);
    if (firstDynamicEvent) this.observedDynamicSessions.add(nativeSessionId);
    const combinedPrefix = [
      ...(this.deferredPrefixes.get(nativeSessionId) ?? []),
      ...missingTail,
    ];
    if (!this.activatedSessions.has(nativeSessionId)
      && combinedPrefix.every((item) => isDeferredSessionPrelude(item))) {
      this.deferredPrefixes.set(nativeSessionId, combinedPrefix);
      return;
    }
    this.activatedSessions.add(nativeSessionId);
    this.deferredPrefixes.delete(nativeSessionId);
    const queue = this.queues.get(nativeSessionId) ?? [];
    queue.push({
      event,
      header,
      initialPrefix: firstDynamicEvent && currentRevision === 0 ? eventPrefix : combinedPrefix,
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
        try {
          let batch = this.pendingBatches.get(nativeSessionId);
          if (batch === undefined) {
            const first = queue![0]!;
            const metadata = await this.metadata(nativeSessionId, first.header);
            const queueLength = queue!.length;
            const queuedBatch = queue!.slice(0, queueLength);
            const last = queuedBatch.at(-1)!;
            const envelope = object(last.event, "Alpha2 session/event");
            if (!Number.isSafeInteger(envelope.seq)) throw new TypeError("Alpha2 session/event lacks a safe seq");
            const events = queuedBatch.flatMap((queued) => [...queued.initialPrefix]);
            const nativeRevision = Number(envelope.seq) + 1;
            if (events.length === 0 || nativeRevision < events.length) {
              throw new TypeError("Alpha2 runtime batch does not form a valid native revision");
            }
            batch = {
              queueLength,
              operation: {
                runId: this.runId as never,
                operationId: `${this.runId}:${nativeSessionId}:${String(envelope.seq)}` as never,
                nativeSessionId: nativeSessionId as NativeSessionId,
                nativeRevision,
                payload: {
                  logicalSessionId: metadata.logicalSessionId,
                  baseVersionId: metadata.baseVersionId,
                  events,
                },
                observedAt: this.clock(),
              },
            };
            this.pendingBatches.set(nativeSessionId, batch);
          }
          const response = await this.post(`/v1/runtime-broker/runs/${encodeURIComponent(this.runId)}/append`, {
            schemaVersion: 1,
            clientId: this.clientId,
            operation: batch.operation,
          });
          const advanced = committedMetadata(response);
          if (advanced !== undefined) this.dynamicMetadata.set(nativeSessionId, advanced);
          queue!.splice(0, batch.queueLength);
          this.pendingBatches.delete(nativeSessionId);
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
    const existing = this.dynamicMetadata.get(nativeSessionId);
    if (existing !== undefined) return existing;
    const projected = this.registrar.session(this.runId, nativeSessionId);
    if (projected !== undefined) return projectedMetadata(projected.payload);
    const response = await this.post(`/v1/runtime-broker/runs/${encodeURIComponent(this.runId)}/sessions`, {
      schemaVersion: 1,
      clientId: this.clientId,
      runId: this.runId,
      nativeSessionId,
      header,
      title: `DSH session ${nativeSessionId}`,
    }) as { readonly session?: { readonly logicalSessionId?: unknown; readonly baseVersionId?: unknown } };
    if (typeof response.session?.logicalSessionId !== "string"
      || (response.session.baseVersionId !== null && typeof response.session.baseVersionId !== "string")) {
      throw new TypeError("Runtime Broker returned an invalid new-session registration");
    }
    const metadata = {
      logicalSessionId: response.session.logicalSessionId,
      baseVersionId: response.session.baseVersionId as string | null,
    };
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
