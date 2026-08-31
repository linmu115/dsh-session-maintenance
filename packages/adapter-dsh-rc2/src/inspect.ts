import type { AdapterVerificationResult, JsonValue, ProjectionInspection, ProjectionManifest, ProjectionReader } from "@linmu/dsh-session-adapter-sdk";

import { rc2CatalogDigest, rc2Digest, type Rc2ProjectionSession } from "./materialize.js";

function record(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } { return value !== null && typeof value === "object" && !Array.isArray(value); }
function parse(value: JsonValue): Rc2ProjectionSession {
  if (!record(value) || !record(value.header) || value.header.type !== "session" || value.header.version !== 0 || !Array.isArray(value.events)) throw new TypeError("RC2 projection session payload is invalid");
  return value as unknown as Rc2ProjectionSession;
}

export async function inspectRc2(reader: ProjectionReader): Promise<ProjectionInspection> {
  const ids = [...await reader.listNativeSessionIds()].sort();
  const sessionDigests: Record<string, string> = {};
  const workspaceReader = reader as ProjectionReader & { readonly listNativeWorkspaceIds?: () => Promise<readonly string[]> };
  const workspaceIds = workspaceReader.listNativeWorkspaceIds === undefined ? [] : [...await workspaceReader.listNativeWorkspaceIds()];
  const heldOut = new Set<string>();
  for (const id of ids) {
    const value = await reader.readSession(id);
    const payload = parse(value);
    if (payload.header.id !== id) throw new TypeError(`RC2 payload identity mismatch for ${id}`);
    sessionDigests[id] = rc2Digest(value);
    if (workspaceReader.listNativeWorkspaceIds === undefined && payload.projectId !== null) workspaceIds.push(payload.projectId);
    for (const event of payload.events) if (!["user/message", "assistant/message", "tool/call", "tool/result"].includes(event.type)) heldOut.add(event.type);
  }
  return { sessionCount: ids.length, workspaceCount: new Set(workspaceIds).size, catalogDigest: rc2CatalogDigest(sessionDigests, workspaceIds), sessionDigests, issues: [...heldOut].sort().map((type) => ({ code: "RC2_EVENT_HELD_OUT", message: `Event type ${type} is retained by the RC2 envelope but not interpreted`, sourceType: type })) };
}

export function verifyRc2(expected: ProjectionManifest, actual: ProjectionInspection): AdapterVerificationResult {
  const ok = expected.sessionCount === actual.sessionCount && expected.workspaceCount === actual.workspaceCount && expected.catalogDigest === actual.catalogDigest && JSON.stringify(Object.entries(expected.sessionDigests).sort()) === JSON.stringify(Object.entries(actual.sessionDigests).sort());
  return { ok, status: ok ? "verified" : "failed", issues: ok ? actual.issues : [{ code: "RC2_PROJECTION_DIGEST_MISMATCH", message: "The inspected RC2 projection does not match its materialization manifest" }, ...actual.issues] };
}
