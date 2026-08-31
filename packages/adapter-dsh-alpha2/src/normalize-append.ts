import type {
  CanonicalAppendOperation,
  CanonicalEventV1,
  JsonValue,
  LogicalSessionId,
  NativeAppendOperation,
  SessionVersionId,
} from "@linmu/dsh-session-adapter-sdk";

import { digest } from "./materialize.js";

interface NativeEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: JsonValue;
  readonly [key: string]: JsonValue;
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eventIdentity(type: string): {
  readonly kind: CanonicalEventV1["kind"];
  readonly role: CanonicalEventV1["role"];
} {
  if (type === "user/message") return { kind: "user-message", role: "user" };
  if (type === "assistant/message" || type === "assistant/chunk") return { kind: type === "assistant/message" ? "assistant-message" : "reasoning", role: "assistant" };
  if (type === "tool/call") return { kind: "tool-call", role: "assistant" };
  if (type === "tool/result") return { kind: "tool-result", role: "tool" };
  if (type.includes("annotation")) return { kind: "annotation", role: "system" };
  if (type.includes("sticker")) return { kind: "sticker", role: "system" };
  if (type.includes("obsidian") || type.includes("reference")) return { kind: "obsidian-reference", role: "system" };
  return { kind: "opaque-unknown", role: "unknown" };
}

function parseEvent(value: JsonValue): NativeEvent {
  if (!isRecord(value) || typeof value.type !== "string" || !Number.isSafeInteger(value.seq)
    || !Number.isSafeInteger(value.time) || !("data" in value)) {
    throw new TypeError("Alpha2 append contains an invalid SessionEvent envelope");
  }
  return value as unknown as NativeEvent;
}

export function normalizeAlpha2Append(operation: NativeAppendOperation): CanonicalAppendOperation {
  const payload = operation.payload;
  if (!isRecord(payload) || typeof payload.logicalSessionId !== "string" || !Array.isArray(payload.events)) {
    throw new TypeError("Alpha2 append payload requires logicalSessionId and events");
  }
  const logicalSessionId = payload.logicalSessionId as LogicalSessionId;
  const instanceId = typeof payload.instanceId === "string" ? payload.instanceId : "dsh-alpha2";
  const events = payload.events.map((value) => {
    const event = parseEvent(value);
    const identity = eventIdentity(event.type);
    const heldOut = identity.kind === "opaque-unknown";
    return {
      schemaVersion: 1 as const,
      id: `dsh-alpha2:${operation.nativeSessionId}:${event.seq}`,
      logicalSessionId,
      sequence: event.seq,
      kind: identity.kind,
      role: identity.role,
      content: event.data,
      source: {
        platform: "dsh" as const,
        instanceId,
        sessionId: operation.nativeSessionId,
        eventId: String(event.seq),
        cursor: String(operation.nativeRevision),
      },
      contentDigest: digest(value),
      rawPayload: value,
      extensions: {
        dshEventType: event.type,
        ...(heldOut ? { heldOut: true } : {}),
      },
    };
  });
  return {
    runId: operation.runId,
    operationId: operation.operationId,
    nativeSessionId: operation.nativeSessionId,
    logicalSessionId,
    baseVersionId: typeof payload.baseVersionId === "string"
      ? payload.baseVersionId as SessionVersionId
      : null,
    events,
    metadata: {
      observedAt: operation.observedAt,
      nativeRevision: operation.nativeRevision,
      heldOutEventTypes: events.filter((event) => event.kind === "opaque-unknown")
        .map((event) => event.extensions.dshEventType),
    },
  };
}
