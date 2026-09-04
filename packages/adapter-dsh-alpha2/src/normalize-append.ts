import type {
  AdapterEvidencePort,
  AdapterEvidenceRef,
  CanonicalAppendOperation,
  CanonicalEventV1,
  JsonValue,
  LogicalSessionId,
  NativeAppendOperation,
  SessionVersionId,
} from "@linmu/dsh-session-adapter-sdk";

import { digest } from "./materialize.js";
import { manifest } from "./manifest.js";

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

export async function normalizeAlpha2Append(
  operation: NativeAppendOperation,
  evidencePort?: AdapterEvidencePort,
): Promise<CanonicalAppendOperation> {
  const payload = operation.payload;
  if (!isRecord(payload) || typeof payload.logicalSessionId !== "string" || !Array.isArray(payload.events)) {
    throw new TypeError("Alpha2 append payload requires logicalSessionId and events");
  }
  const logicalSessionId = payload.logicalSessionId as LogicalSessionId;
  const instanceId = typeof payload.instanceId === "string" ? payload.instanceId : "dsh-alpha2";
  const events: CanonicalEventV1[] = [];
  for (const value of payload.events) {
    const event = parseEvent(value);
    const identity = eventIdentity(event.type);
    const heldOut = identity.kind === "opaque-unknown";
    let evidenceRef: AdapterEvidenceRef | null = null;
    if (heldOut && evidencePort !== undefined) {
      evidenceRef = (await evidencePort.putEvidence({
        schemaVersion: 1,
        adapterId: manifest.id,
        nativeFormatId: "dsh/0.1.2-alpha.2/session-event-v1",
        sourceKind: `dsh-alpha2/${event.type}`,
        payload: value,
        observedAt: operation.observedAt,
      })).ref;
    }
    const content: JsonValue = heldOut
      ? {
          schemaVersion: 1,
          type: "other",
          reason: "unsupported-source-event",
          sourceKind: `dsh-alpha2/${event.type}`,
          label: "未映射的 Alpha2 记录",
          summary: `MCSF v1 没有 ${event.type} 的公共语义；该记录仅作为维护卡片展示。`,
          evidenceRef,
        }
      : event.data;
    events.push({
      schemaVersion: 1 as const,
      id: `dsh-alpha2:${operation.runId}:${operation.nativeSessionId}:${event.seq}`,
      logicalSessionId,
      sequence: event.seq,
      kind: heldOut ? "other" : identity.kind,
      role: identity.role,
      content,
      source: {
        platform: "dsh" as const,
        instanceId,
        sessionId: operation.nativeSessionId,
        eventId: String(event.seq),
        cursor: String(operation.nativeRevision),
      },
      contentDigest: digest(content),
      rawPayload: heldOut ? null : value,
      extensions: {
        dshEventType: event.type,
        ...(heldOut ? { heldOut: true } : {}),
      },
    });
  }
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
      heldOutEventTypes: events.filter((event) => event.kind === "other")
        .map((event) => event.extensions.dshEventType)
        .filter((type): type is string => typeof type === "string"),
      evidenceRefs: events.filter((event) => event.kind === "other")
        .map((event) => (event.content as { readonly evidenceRef?: JsonValue }).evidenceRef)
        .filter((ref): ref is string => typeof ref === "string"),
    },
  };
}
