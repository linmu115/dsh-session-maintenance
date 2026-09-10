import type { JsonValue, NativeSessionId } from "@linmu/dsh-session-adapter-sdk";
import type { RunId } from "@linmu/dsh-session-contracts";
import { readProjectionRecoveryDescriptor } from "./recovery.js";

import {
  JsonProjectionDirectory,
  projectionRootFor,
  type ProjectionRuntimeCatalogEntry,
} from "./materialize.js";

export const PROJECTION_EVENT_CHUNK_TARGET_BYTES = 512 * 1024;
export const PROJECTION_EVENT_HARD_LIMIT_BYTES = 8 * 1024 * 1024;
export const PROJECTION_CATALOG_CHUNK_TARGET_BYTES = 512 * 1024;
export const PROJECTION_CATALOG_ENTRY_HARD_LIMIT_BYTES = 8 * 1024 * 1024;

export interface ProjectionRuntimeCatalogBeginFrame {
  readonly type: "catalog-begin";
  readonly schemaVersion: 2;
  readonly runId: RunId;
  readonly hotLimit: number;
  readonly nativeMode?: "persistent-native-v1";
  readonly sessionCount: number;
}

export interface ProjectionRuntimeCatalogSessionsFrame {
  readonly type: "catalog-sessions";
  readonly sessions: readonly (ProjectionRuntimeCatalogEntry & { readonly hot: boolean })[];
}

export interface ProjectionRuntimeCatalogEndFrame {
  readonly type: "catalog-end";
  readonly sessionCount: number;
}

export interface ProjectionRuntimeSessionBeginFrame {
  readonly type: "session-begin";
  readonly nativeSessionId: NativeSessionId;
}

export interface ProjectionRuntimeEventsFrame {
  readonly type: "events";
  readonly nativeSessionId: NativeSessionId;
  readonly events: readonly JsonValue[];
}

export interface ProjectionRuntimeSessionEndFrame {
  readonly type: "session-end";
  readonly nativeSessionId: NativeSessionId;
  readonly eventCount: number;
}

export type ProjectionRuntimeStreamFrame =
  | ProjectionRuntimeCatalogBeginFrame
  | ProjectionRuntimeCatalogSessionsFrame
  | ProjectionRuntimeCatalogEndFrame
  | ProjectionRuntimeSessionBeginFrame
  | ProjectionRuntimeEventsFrame
  | ProjectionRuntimeSessionEndFrame;

export interface ProjectionRuntimeNdjsonStream {
  readonly frames: AsyncIterable<string>;
}

export class ProjectionRuntimeStreamError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProjectionRuntimeStreamError";
  }
}

function objectPayload(value: JsonValue): { readonly [key: string]: JsonValue } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectionRuntimeStreamError("PROJECTION_SESSION_INVALID", "Projection session payload must be an object");
  }
  return value as { readonly [key: string]: JsonValue };
}

function line(value: ProjectionRuntimeStreamFrame): string {
  return `${JSON.stringify(value)}\n`;
}

function eventsLine(nativeSessionId: NativeSessionId, serializedEvents: readonly string[]): string {
  return `{"type":"events","nativeSessionId":${JSON.stringify(nativeSessionId)},"events":[${serializedEvents.join(",")}]}\n`;
}

function catalogSessionsLine(serializedSessions: readonly string[]): string {
  return `{"type":"catalog-sessions","sessions":[${serializedSessions.join(",")}]}\n`;
}

function* chunkCatalogSessions(
  sessions: readonly (ProjectionRuntimeCatalogEntry & { readonly hot: boolean })[],
): Generator<string> {
  const emptyBytes = Buffer.byteLength(catalogSessionsLine([]), "utf8");
  let current: string[] = [];
  let currentBytes = emptyBytes;
  for (const session of sessions) {
    const serialized = JSON.stringify(session);
    const sessionBytes = Buffer.byteLength(serialized, "utf8");
    if (emptyBytes + sessionBytes > PROJECTION_CATALOG_ENTRY_HARD_LIMIT_BYTES) {
      throw new ProjectionRuntimeStreamError(
        "PROJECTION_CATALOG_ENTRY_TOO_LARGE",
        `Projection catalog entry ${session.nativeSessionId} exceeds the 8 MiB hard limit`,
      );
    }
    const separatorBytes = current.length === 0 ? 0 : 1;
    if (current.length > 0 && currentBytes + separatorBytes + sessionBytes > PROJECTION_CATALOG_CHUNK_TARGET_BYTES) {
      yield catalogSessionsLine(current);
      current = [];
      currentBytes = emptyBytes;
    }
    current.push(serialized);
    currentBytes += (current.length === 1 ? 0 : 1) + sessionBytes;
    if (currentBytes > PROJECTION_CATALOG_CHUNK_TARGET_BYTES) {
      yield catalogSessionsLine(current);
      current = [];
      currentBytes = emptyBytes;
    }
  }
  if (current.length > 0) yield catalogSessionsLine(current);
}

function* chunkEvents(nativeSessionId: NativeSessionId, events: readonly JsonValue[]): Generator<string> {
  const emptyBytes = Buffer.byteLength(eventsLine(nativeSessionId, []), "utf8");
  let current: string[] = [];
  let currentBytes = emptyBytes;
  for (const event of events) {
    const serialized = JSON.stringify(event);
    const eventBytes = Buffer.byteLength(serialized, "utf8");
    const isolatedBytes = emptyBytes + eventBytes;
    if (isolatedBytes > PROJECTION_EVENT_HARD_LIMIT_BYTES) {
      throw new ProjectionRuntimeStreamError(
        "PROJECTION_EVENT_TOO_LARGE",
        `Projection event in ${nativeSessionId} exceeds the 8 MiB hard limit`,
      );
    }
    const separatorBytes = current.length === 0 ? 0 : 1;
    if (current.length > 0 && currentBytes + separatorBytes + eventBytes > PROJECTION_EVENT_CHUNK_TARGET_BYTES) {
      yield eventsLine(nativeSessionId, current);
      current = [];
      currentBytes = emptyBytes;
    }
    current.push(serialized);
    currentBytes += (current.length === 1 ? 0 : 1) + eventBytes;
    if (currentBytes > PROJECTION_EVENT_CHUNK_TARGET_BYTES) {
      yield eventsLine(nativeSessionId, current);
      current = [];
      currentBytes = emptyBytes;
    }
  }
  if (current.length > 0) yield eventsLine(nativeSessionId, current);
}

function sessionPayload(
  nativeSessionId: NativeSessionId,
  payload: JsonValue,
  expectedEventCount: number,
): readonly JsonValue[] {
  const record = objectPayload(payload);
  if (!Array.isArray(record.events)) {
    throw new ProjectionRuntimeStreamError("PROJECTION_SESSION_INVALID", `Projection session ${nativeSessionId} has no events array`);
  }
  if (record.events.length !== expectedEventCount) {
    throw new ProjectionRuntimeStreamError(
      "PROJECTION_CATALOG_STALE",
      `Projection session ${nativeSessionId} event count differs from its catalog entry`,
    );
  }
  return record.events;
}

async function* streamSession(
  directory: JsonProjectionDirectory,
  entry: ProjectionRuntimeCatalogEntry,
  preloadedPayload?: JsonValue,
): AsyncGenerator<string> {
  const events = sessionPayload(
    entry.nativeSessionId,
    preloadedPayload ?? await directory.readSession(entry.nativeSessionId),
    entry.eventCount,
  );
  yield line({ type: "session-begin", nativeSessionId: entry.nativeSessionId });
  yield* chunkEvents(entry.nativeSessionId, events);
  yield line({ type: "session-end", nativeSessionId: entry.nativeSessionId, eventCount: events.length });
}

export async function openProjectionRuntimeStream(
  runtimeRoot: string,
  runId: RunId,
  hotLimit = 200,
): Promise<ProjectionRuntimeNdjsonStream> {
  if (!Number.isSafeInteger(hotLimit) || hotLimit < 0 || hotLimit > 1_000) {
    throw new ProjectionRuntimeStreamError("HOT_LIMIT_INVALID", "Projection hotLimit must be between 0 and 1000");
  }
  const directory = new JsonProjectionDirectory(projectionRootFor(runtimeRoot, runId));
  const sidecar = await directory.readSessionCatalog(runId);
  const descriptor = await readProjectionRecoveryDescriptor(directory.root).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  const nativeMode = descriptor?.nativeSpace ? "persistent-native-v1" as const : undefined;
  if (nativeMode) hotLimit = 0;
  const sessions = sidecar.sessions.map((entry, index) => ({ ...entry, hot: index < hotLimit }));
  return {
    frames: (async function* () {
      yield line({ type: "catalog-begin", schemaVersion: 2, runId, hotLimit, sessionCount: sessions.length,
        ...(nativeMode ? { nativeMode } : {}) });
      yield* chunkCatalogSessions(sessions);
      yield line({ type: "catalog-end", sessionCount: sessions.length });
      for (const entry of sidecar.sessions.slice(0, hotLimit)) {
        yield* streamSession(directory, entry);
      }
    })(),
  };
}

export async function openProjectionRuntimeSessionStream(
  runtimeRoot: string,
  runId: RunId,
  nativeSessionId: NativeSessionId,
): Promise<ProjectionRuntimeNdjsonStream | undefined> {
  const directory = new JsonProjectionDirectory(projectionRootFor(runtimeRoot, runId));
  const sidecar = await directory.readSessionCatalog(runId);
  const entry = sidecar.sessions.find((candidate) => candidate.nativeSessionId === nativeSessionId);
  if (entry === undefined) return undefined;
  const payload = await directory.readSession(nativeSessionId);
  sessionPayload(nativeSessionId, payload, entry.eventCount);
  return { frames: streamSession(directory, entry, payload) };
}
