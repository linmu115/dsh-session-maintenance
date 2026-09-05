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
import { CANONICAL_CONVERSATION_TOPOLOGY_EXTENSION } from "@linmu/dsh-session-adapter-sdk";

import { digest } from "./materialize.js";
import { manifest } from "./manifest.js";

interface NativeEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: JsonValue;
  readonly [key: string]: JsonValue;
}

type CanonicalHistoryMode = "native" | "portable";

// These are known SessionEvent controls, not unknown conversation semantics.
// Native history must retain them or later chunks/results have no open turn.
const NATIVE_CONTROL_TYPES = new Set([
  "turn/start", "turn/end", "step/start", "step/end",
  "request/header", "request/context", "session/end-seed",
]);

const PORTABLE_EVIDENCE_ONLY_TYPES = new Set([
  "turn/start",
  "turn/end",
  "step/start",
  "step/end",
  "assistant/chunk",
  "request/header",
  "request/context",
  "session/end-seed",
]);

function isRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eventIdentity(type: string): {
  readonly kind: CanonicalEventV1["kind"];
  readonly role: CanonicalEventV1["role"];
} {
  if (NATIVE_CONTROL_TYPES.has(type)) return { kind: "system-metadata", role: "system" };
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
    throw new TypeError("Rc1 append contains an invalid SessionEvent envelope");
  }
  return value as unknown as NativeEvent;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function messageRecord(data: JsonValue): { readonly [key: string]: JsonValue } | undefined {
  if (!isRecord(data)) return undefined;
  return isRecord(data.message) ? data.message : data;
}

function portableMessageContent(event: NativeEvent): JsonValue {
  const message = messageRecord(event.data);
  if (message === undefined) return event.data;
  if (event.type !== "assistant/message" || !Array.isArray(message.content)) return message;
  return {
    ...message,
    // RC1 also persists each tool invocation as a correlated tool/call row.
    // Keeping the embedded block would duplicate it in MCSF and later violate
    // provider tool-call ordering.
    content: message.content.filter((block) =>
      !isRecord(block) || (block.type !== "tool-call" && block.type !== "tool-result")),
  };
}

function textFromBlocks(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value === undefined ? "" : JSON.stringify(value);
  return value.map((block) => {
    if (typeof block === "string") return block;
    if (!isRecord(block)) return JSON.stringify(block);
    if (typeof block.text === "string") return block.text;
    if (block.type === "image") return "[DSH 工具图像输出]";
    return JSON.stringify(block);
  }).join("\n");
}

function portableToolResult(event: NativeEvent): JsonValue | undefined {
  if (!isRecord(event.data)) return undefined;
  const message = isRecord(event.data.message) ? event.data.message : undefined;
  const source = isRecord(message?.source) ? message.source : undefined;
  const block = Array.isArray(message?.content)
    ? message.content.find((candidate) => isRecord(candidate) && candidate.type === "tool-result")
    : undefined;
  const toolBlock = isRecord(block) ? block : undefined;
  const callId = stringValue(toolBlock?.toolCallId)
    ?? stringValue(source?.callId)
    ?? stringValue(event.data.callId);
  if (callId === undefined) return undefined;
  const meta = isRecord(event.data.meta) ? event.data.meta : undefined;
  return {
    callId,
    name: stringValue(meta?.name) ?? stringValue(event.data.name) ?? "dsh-tool",
    protocol: stringValue(meta?.protocol) ?? "dsh",
    outputText: textFromBlocks(toolBlock?.content ?? event.data.content),
    ...(toolBlock?.isError === true || event.data.error !== undefined ? { isError: true } : {}),
  };
}

function portableCoreContent(event: NativeEvent): {
  readonly kind: CanonicalEventV1["kind"];
  readonly role: CanonicalEventV1["role"];
  readonly content: JsonValue;
} | undefined {
  if (event.type === "user/message") {
    return { kind: "user-message", role: "user", content: portableMessageContent(event) };
  }
  if (event.type === "assistant/message") {
    return { kind: "assistant-message", role: "assistant", content: portableMessageContent(event) };
  }
  if (event.type === "tool/call" && isRecord(event.data)) {
    const callId = stringValue(event.data.callId);
    const name = stringValue(event.data.name);
    if (callId === undefined || name === undefined || typeof event.data.arguments !== "string") return undefined;
    return {
      kind: "tool-call",
      role: "assistant",
      content: { callId, name, protocol: "dsh", arguments: event.data.arguments },
    };
  }
  if (event.type === "tool/result") {
    const content = portableToolResult(event);
    return content === undefined ? undefined : { kind: "tool-result", role: "tool", content };
  }
  return undefined;
}

function withoutTopology(
  extensions: CanonicalEventV1["extensions"],
): CanonicalEventV1["extensions"] {
  const {
    [CANONICAL_CONVERSATION_TOPOLOGY_EXTENSION]: _topology,
    ...rest
  } = extensions;
  return rest;
}

function portableOtherContent(type: string): JsonValue {
  return {
    schemaVersion: 1,
    type: "other",
    reason: "adapter-evidence",
    sourceKind: `dsh-rc1/${type}`,
    label: "无法安全续写的 RC1 记录",
    summary: `${type} 缺少 RC1 公共字段，已从模型上下文隔离；原始证据仍保留在旧版本。`,
    evidenceRef: null,
  };
}

/**
 * Convert an existing native RC1/Alpha2 suffix to portable MCSF semantics.
 * Event identities and provenance remain stable; native envelopes remain in
 * the immutable old version and never leak into the new active head.
 */
export function portableizeRc1CanonicalHistory(
  events: readonly CanonicalEventV1[],
): readonly CanonicalEventV1[] {
  const result: CanonicalEventV1[] = [];
  for (const event of events) {
    const raw = event.rawPayload === null ? undefined : (() => {
      try { return parseEvent(event.rawPayload); } catch { return undefined; }
    })();
    const eventType = raw?.type
      ?? (typeof event.extensions.dshEventType === "string" ? event.extensions.dshEventType : undefined);
    if (eventType !== undefined && PORTABLE_EVIDENCE_ONLY_TYPES.has(eventType)) continue;
    if (raw !== undefined) {
      const portable = portableCoreContent(raw);
      if (portable !== undefined) {
        result.push({
          ...event,
          kind: portable.kind,
          role: portable.role,
          content: portable.content,
          contentDigest: digest(portable.content),
          rawPayload: null,
          extensions: { ...withoutTopology(event.extensions), portableFromRc1: true },
        });
        continue;
      }
      if (["user/message", "assistant/message", "tool/call", "tool/result"].includes(raw.type)) {
        const content = portableOtherContent(raw.type);
        result.push({
          ...event,
          kind: "other",
          role: "unknown",
          content,
          contentDigest: digest(content),
          rawPayload: null,
          extensions: { ...withoutTopology(event.extensions), portableFromRc1: true, heldOut: true },
        });
        continue;
      }
    }
    result.push({ ...event, extensions: withoutTopology(event.extensions) });
  }
  return result;
}

export async function normalizeRc1Append(
  operation: NativeAppendOperation,
  evidencePort?: AdapterEvidencePort,
): Promise<CanonicalAppendOperation> {
  const payload = operation.payload;
  if (!isRecord(payload) || typeof payload.logicalSessionId !== "string" || !Array.isArray(payload.events)) {
    throw new TypeError("Rc1 append payload requires logicalSessionId and events");
  }
  const logicalSessionId = payload.logicalSessionId as LogicalSessionId;
  const instanceId = typeof payload.instanceId === "string" ? payload.instanceId : "dsh-rc1";
  if (payload.canonicalHistoryMode !== undefined
    && payload.canonicalHistoryMode !== "native"
    && payload.canonicalHistoryMode !== "portable") {
    throw new TypeError("Rc1 append payload has an invalid canonicalHistoryMode");
  }
  const historyMode: CanonicalHistoryMode = payload.canonicalHistoryMode === "portable" ? "portable" : "native";
  const events: CanonicalEventV1[] = [];
  const heldOutEventTypes: string[] = [];
  const evidenceRefs: AdapterEvidenceRef[] = [];
  for (const value of payload.events) {
    const event = parseEvent(value);
    const identity = eventIdentity(event.type);
    const portable = historyMode === "portable" ? portableCoreContent(event) : undefined;
    const evidenceOnly = historyMode === "portable" && PORTABLE_EVIDENCE_ONLY_TYPES.has(event.type);
    const malformedPortableCore = historyMode === "portable"
      && ["user/message", "assistant/message", "tool/call", "tool/result"].includes(event.type)
      && portable === undefined;
    const heldOut = identity.kind === "opaque-unknown" || evidenceOnly || malformedPortableCore;
    let evidenceRef: AdapterEvidenceRef | null = null;
    if (heldOut && evidencePort !== undefined) {
      evidenceRef = (await evidencePort.putEvidence({
        schemaVersion: 1,
        adapterId: manifest.id,
        nativeFormatId: "dsh/0.1.2-rc.1/session-event-v1",
        sourceKind: `dsh-rc1/${event.type}`,
        payload: value,
        observedAt: operation.observedAt,
      })).ref;
      evidenceRefs.push(evidenceRef);
    }
    if (evidenceOnly) {
      heldOutEventTypes.push(event.type);
      continue;
    }
    const content: JsonValue = heldOut
      ? {
          schemaVersion: 1,
          type: "other",
          reason: "unsupported-source-event",
          sourceKind: `dsh-rc1/${event.type}`,
          label: "未映射的 Rc1 记录",
          summary: `MCSF v1 没有 ${event.type} 的公共语义；该记录仅作为维护卡片展示。`,
          evidenceRef,
        }
      : portable?.content ?? event.data;
    if (heldOut) heldOutEventTypes.push(event.type);
    events.push({
      schemaVersion: 1 as const,
      id: `dsh-rc1:${operation.runId}:${operation.nativeSessionId}:${event.seq}`,
      logicalSessionId,
      sequence: event.seq,
      kind: heldOut ? "other" : portable?.kind ?? identity.kind,
      role: heldOut ? "unknown" : portable?.role ?? identity.role,
      content,
      source: {
        platform: "dsh" as const,
        instanceId,
        sessionId: operation.nativeSessionId,
        eventId: String(event.seq),
        cursor: String(operation.nativeRevision),
      },
      contentDigest: digest(content),
      rawPayload: heldOut || portable !== undefined ? null : value,
      extensions: {
        dshEventType: event.type,
        ...(heldOut ? { heldOut: true } : {}),
        ...(portable === undefined ? {} : { portableFromRc1: true }),
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
      canonicalHistoryMode: historyMode,
      heldOutEventTypes,
      evidenceRefs,
    },
  };
}
