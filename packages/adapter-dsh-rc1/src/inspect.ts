import type {
  AdapterVerificationResult,
  JsonValue,
  ProjectionInspection,
  ProjectionManifest,
  ProjectionReader,
} from "@linmu/dsh-session-adapter-sdk";

import { catalogDigest, digest, type Rc1ProjectionSession } from "./materialize.js";

const CORE_EVENT_TYPES = new Set([
  "turn/start",
  "turn/end",
  "step/start",
  "step/end",
  "user/message",
  "assistant/chunk",
  "assistant/message",
  "tool/call",
  "tool/result",
  "request/header",
  "request/context",
  "session/end-seed",
]);

function isRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePayload(value: JsonValue): Rc1ProjectionSession {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.header) || !Array.isArray(value.events)) {
    throw new TypeError("Rc1 projection session payload is invalid");
  }
  if (value.header.isSeeded !== false || value.inheritedEventCount !== 0) {
    throw new TypeError("Rc1 Maintenance projection must use an unseeded SessionHeader with offset zero");
  }
  return value as unknown as Rc1ProjectionSession;
}

export async function inspectRc1(reader: ProjectionReader): Promise<ProjectionInspection> {
  const ids = [...await reader.listNativeSessionIds()].sort();
  const sessionDigests: Record<string, string> = {};
  const workspaceReader = reader as ProjectionReader & {
    readonly listNativeWorkspaceIds?: () => Promise<readonly string[]>;
  };
  const workspaceIds: string[] = workspaceReader.listNativeWorkspaceIds === undefined
    ? []
    : [...await workspaceReader.listNativeWorkspaceIds()];
  const heldOut = new Set<string>();
  for (const id of ids) {
    const value = await reader.readSession(id);
    const payload = parsePayload(value);
    if (payload.header.id !== id) throw new TypeError(`Rc1 payload identity mismatch for ${id}`);
    sessionDigests[id] = digest(value);
    if (workspaceReader.listNativeWorkspaceIds === undefined && payload.workspaceId !== null) {
      workspaceIds.push(payload.workspaceId);
    }
    for (const event of payload.events) {
      if (!CORE_EVENT_TYPES.has(event.type)) heldOut.add(event.type);
    }
  }
  return {
    sessionCount: ids.length,
    workspaceCount: new Set(workspaceIds).size,
    catalogDigest: catalogDigest(sessionDigests, workspaceIds),
    sessionDigests,
    issues: [...heldOut].sort().map((type) => ({
      code: "RC1_EVENT_HELD_OUT",
      message: `Event type ${type} was preserved verbatim but is not interpreted by the Rc1 core codec`,
      sourceType: type,
    })),
  };
}

export function verifyRc1(
  expected: ProjectionManifest,
  actual: ProjectionInspection,
): AdapterVerificationResult {
  const expectedDigestEntries = Object.entries(expected.sessionDigests)
    .sort(([left], [right]) => left.localeCompare(right));
  const actualDigestEntries = Object.entries(actual.sessionDigests)
    .sort(([left], [right]) => left.localeCompare(right));
  const digestsMatch = JSON.stringify(expectedDigestEntries) === JSON.stringify(actualDigestEntries);
  const ok = expected.sessionCount === actual.sessionCount
    && expected.workspaceCount === actual.workspaceCount
    && expected.catalogDigest === actual.catalogDigest
    && digestsMatch;
  return {
    ok,
    status: ok ? "verified" : "failed",
    issues: ok ? actual.issues : [{
      code: "RC1_PROJECTION_DIGEST_MISMATCH",
      message: "The inspected Rc1 projection does not match its materialization manifest",
    }, ...actual.issues],
  };
}
