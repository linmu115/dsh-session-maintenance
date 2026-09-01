import type {
  JsonValue,
  NativeRecoverySession,
  ProjectionSession,
} from "@linmu/dsh-session-adapter-sdk";

function record(value: JsonValue, description: string): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object`);
  }
  return value as Readonly<Record<string, JsonValue>>;
}

export function recoverAlpha2ProjectionSession(
  projection: ProjectionSession,
  payload: JsonValue,
): NativeRecoverySession {
  const session = record(payload, "Alpha2 recovery session");
  if (session.header === undefined) throw new TypeError("Alpha2 recovery SessionHeader is missing");
  const header = record(session.header, "Alpha2 recovery SessionHeader");
  if (header.id !== projection.nativeSessionId) {
    throw new TypeError(`Alpha2 recovery header ID mismatch: ${projection.nativeSessionId}`);
  }
  if (session.logicalSessionId !== projection.logicalSessionId) {
    throw new TypeError(`Alpha2 recovery logical session mismatch: ${projection.logicalSessionId}`);
  }
  if (!Array.isArray(session.events) || session.events.length < projection.nativeRevision) {
    throw new TypeError(`Alpha2 recovery projection is shorter than committed revision: ${projection.nativeSessionId}`);
  }
  if (!Array.isArray(session.tags) || session.tags.some((tag) => typeof tag !== "string")) {
    throw new TypeError(`Alpha2 recovery tags are invalid: ${projection.nativeSessionId}`);
  }
  const workspaceId = session.workspaceId;
  const projectId = session.projectId;
  if (workspaceId !== null && typeof workspaceId !== "string") {
    throw new TypeError(`Alpha2 recovery workspace is invalid: ${projection.nativeSessionId}`);
  }
  if (projectId !== null && typeof projectId !== "string") {
    throw new TypeError(`Alpha2 recovery project is invalid: ${projection.nativeSessionId}`);
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
  } as NativeRecoverySession;
}
