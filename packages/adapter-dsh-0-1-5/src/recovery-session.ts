import type {
  JsonValue,
  NativeSessionId,
  NativeRecoverySession,
  ProjectionSession,
  RunId,
  UnmappedNativeRecoverySession,
} from "@linmu/dsh-session-adapter-sdk";

import {
  parseV3LogicalSessionHeader,
  validateV3Lineage,
} from "./lineage.js";
import { v3SessionLogOffset } from "./native-types.js";

function record(value: JsonValue, description: string): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object`);
  }
  return value as Readonly<Record<string, JsonValue>>;
}

export function recoverV3ProjectionSession(
  projection: ProjectionSession,
  payload: JsonValue,
): NativeRecoverySession {
  const session = record(payload, "V3 recovery session");
  if (session.header === undefined) throw new TypeError("V3 recovery SessionHeader is missing");
  const header = parseV3LogicalSessionHeader(
    session.header,
    projection.nativeSessionId,
    "V3 recovery SessionHeader",
  );
  if (session.logicalSessionId !== projection.logicalSessionId) {
    throw new TypeError(`V3 recovery logical session mismatch: ${projection.logicalSessionId}`);
  }
  if (typeof session.inheritedEventCount !== "number") {
    throw new TypeError(`V3 recovery lineage is invalid: ${projection.nativeSessionId}`);
  }
  const inheritedEventCount = v3SessionLogOffset(session.inheritedEventCount);
  validateV3Lineage(header, inheritedEventCount);
  if (!Array.isArray(session.events) || session.events.length < projection.nativeRevision) {
    throw new TypeError(`V3 recovery projection is shorter than committed revision: ${projection.nativeSessionId}`);
  }
  if (!Array.isArray(session.tags) || session.tags.some((tag) => typeof tag !== "string")) {
    throw new TypeError(`V3 recovery tags are invalid: ${projection.nativeSessionId}`);
  }
  const workspaceId = session.workspaceId;
  const projectId = session.projectId;
  if (workspaceId !== null && typeof workspaceId !== "string") {
    throw new TypeError(`V3 recovery workspace is invalid: ${projection.nativeSessionId}`);
  }
  if (projectId !== null && typeof projectId !== "string") {
    throw new TypeError(`V3 recovery project is invalid: ${projection.nativeSessionId}`);
  }
  return {
    title: typeof session.title === "string" ? session.title : "Untitled DSH session",
    tags: session.tags as readonly string[],
    archivedAt: null,
    workspaceId,
    authorityScope: "maintenance",
    projectId,
    header,
    committedEvents: session.events.slice(0, projection.nativeRevision),
    adapterMetadata: { inheritedEventCount },
  } as NativeRecoverySession;
}

export function recoverUnmappedV3ProjectionSession(
  _runId: RunId,
  nativeSessionId: NativeSessionId,
  payload: JsonValue,
): UnmappedNativeRecoverySession {
  const session = record(payload, "V3 unmapped recovery session");
  if (session.logicalSessionId === undefined || typeof session.logicalSessionId !== "string") {
    throw new TypeError(`V3 unmapped recovery logical session is invalid: ${nativeSessionId}`);
  }
  if (session.baseVersionId !== null) {
    throw new TypeError(`V3 unmapped recovery session has a committed base: ${nativeSessionId}`);
  }
  if (!Array.isArray(session.events) || session.events.length !== 0) {
    throw new TypeError(`V3 unmapped recovery session is not an empty registration: ${nativeSessionId}`);
  }
  const projection: ProjectionSession = {
    schemaVersion: 1,
    runId: _runId,
    nativeSessionId,
    logicalSessionId: session.logicalSessionId as ProjectionSession["logicalSessionId"],
    baseVersionId: null,
    mode: "maintenance-write",
    nativeRevision: 0,
    lastCommittedOperationId: null,
    derivedChildSessionId: null,
  };
  return {
    logicalSessionId: projection.logicalSessionId,
    baseVersionId: null,
    mode: "maintenance-write",
    nativeRevision: 0,
    recovered: recoverV3ProjectionSession(projection, payload),
  };
}
