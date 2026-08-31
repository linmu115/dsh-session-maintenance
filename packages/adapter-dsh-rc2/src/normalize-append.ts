import type { CanonicalAppendOperation, CanonicalEventV1, JsonValue, LogicalSessionId, NativeAppendOperation, SessionVersionId } from "@linmu/dsh-session-adapter-sdk";

import { rc2Digest } from "./materialize.js";

function record(value: JsonValue): value is { readonly [key: string]: JsonValue } { return value !== null && typeof value === "object" && !Array.isArray(value); }
function identity(type: string): { readonly kind: CanonicalEventV1["kind"]; readonly role: CanonicalEventV1["role"] } {
  if (type === "user/message") return { kind: "user-message", role: "user" };
  if (type === "assistant/message") return { kind: "assistant-message", role: "assistant" };
  if (type === "tool/call") return { kind: "tool-call", role: "assistant" };
  if (type === "tool/result") return { kind: "tool-result", role: "tool" };
  if (type.includes("annotation")) return { kind: "annotation", role: "system" };
  if (type.includes("sticker")) return { kind: "sticker", role: "system" };
  if (type.includes("reference") || type.includes("obsidian")) return { kind: "obsidian-reference", role: "system" };
  return { kind: "opaque-unknown", role: "unknown" };
}

export function normalizeRc2Append(operation: NativeAppendOperation): CanonicalAppendOperation {
  if (!record(operation.payload) || typeof operation.payload.logicalSessionId !== "string" || !Array.isArray(operation.payload.events)) throw new TypeError("RC2 append payload requires logicalSessionId and events");
  const logicalSessionId = operation.payload.logicalSessionId as LogicalSessionId;
  const instanceId = typeof operation.payload.instanceId === "string" ? operation.payload.instanceId : "dsh-rc2";
  const events = operation.payload.events.map((value) => {
    if (!record(value) || typeof value.type !== "string" || !Number.isSafeInteger(value.seq) || !Number.isSafeInteger(value.time) || !("data" in value)) throw new TypeError("RC2 append contains an invalid session event envelope");
    const event = value as { readonly type: string; readonly seq: number; readonly data: JsonValue } & Record<string, JsonValue>;
    const mapped = identity(event.type);
    return { schemaVersion: 1 as const, id: `dsh-rc2:${operation.nativeSessionId}:${event.seq}`, logicalSessionId, sequence: event.seq, kind: mapped.kind, role: mapped.role, content: event.data, source: { platform: "dsh" as const, instanceId, sessionId: operation.nativeSessionId, eventId: String(event.seq), cursor: String(operation.nativeRevision) }, contentDigest: rc2Digest(value), rawPayload: value, extensions: { dshEventType: event.type, ...(mapped.kind === "opaque-unknown" ? { heldOut: true } : {}) } };
  });
  return { runId: operation.runId, operationId: operation.operationId, nativeSessionId: operation.nativeSessionId, logicalSessionId, baseVersionId: typeof operation.payload.baseVersionId === "string" ? operation.payload.baseVersionId as SessionVersionId : null, events, metadata: { observedAt: operation.observedAt, nativeRevision: operation.nativeRevision, heldOutEventTypes: events.filter((event) => event.kind === "opaque-unknown").map((event) => event.extensions.dshEventType) } };
}
