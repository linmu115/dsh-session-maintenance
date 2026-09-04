import type {
  AttachmentRef,
  CanonicalConversationPhase,
  CanonicalConversationTopologyV1,
  CanonicalEventKind,
  CanonicalEventRole,
  CompatibilityIssue,
  JsonValue,
  StableObservation,
} from "@linmu/dsh-session-contracts";
import { CANONICAL_CONVERSATION_TOPOLOGY_EXTENSION } from "@linmu/dsh-session-contracts";
import {
  normalizeSession,
  type RawSessionEvent,
} from "@linmu/dsh-session-domain";

import {
  isCodexObservationPayload,
  type CodexEnvelope,
} from "./parser.js";
import { codexDisplayTitle } from "./thread.js";
import { codexWorkspaceId } from "./workspace.js";
import {
  CODEX_CANONICAL_SEMANTICS_EXTENSION,
  codexCanonicalSemantics,
  type CodexCanonicalSemanticsV1,
  type CodexClassificationSummaryV1,
  type CodexNormalizedSession,
} from "./semantics.js";

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isRecord(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toolOutputText(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (isRecord(part) && typeof part.text === "string") return part.text;
      if (isRecord(part) && part.type === "input_image") return "[Codex 工具图像输出]";
      return JSON.stringify(part);
    }).join("\n");
  }
  return JSON.stringify(value);
}

function toolEvent(
  envelope: CodexEnvelope,
  sourceIndex: number | string,
  sequence: number,
): RawSessionEvent | undefined {
  const payload = envelope.payload;
  const sourceType = stringValue(payload.type);
  if (sourceType === undefined) return undefined;
  const phase = sourceType === "custom_tool_call" || sourceType === "function_call"
    ? "call"
    : sourceType === "custom_tool_call_output" || sourceType === "function_call_output"
      ? "result"
      : undefined;
  if (phase === undefined) return undefined;

  // A Codex output row is correlated only by its explicit call_id. Falling
  // back to the row id turns coordination/status outputs into orphan DSH tool
  // results, which later makes the model request invalid. Both sides of the
  // portable tool pair therefore require Codex's explicit call_id.
  const callId = stringValue(payload.call_id);
  if (callId === undefined) return undefined;
  const protocol = sourceType.startsWith("custom_") ? "custom" : "function";
  const name = stringValue(payload.name)
    ?? (stringValue(payload.namespace) === undefined
      ? "codex-tool"
      : `${payload.namespace}.${stringValue(payload.name) ?? "tool"}`);
  const argumentsText = stringValue(payload.arguments)
    ?? stringValue(payload.input)
    ?? "";
  const outputText = toolOutputText(payload.output);
  return {
    sourceEventId: stringValue(payload.id) ?? `${sourceType}-${sourceIndex}`,
    parentSourceEventId: null,
    sequence,
    kind: "tool-import",
    role: phase === "call" ? "assistant" : "tool",
    content: phase === "call" ? argumentsText : outputText,
    attachments: [],
    extensions: {
      sourceType,
      codexTool: {
        phase,
        protocol,
        callId,
        name,
        ...(phase === "call"
          ? { arguments: argumentsText }
          : { outputText }),
      },
    },
  };
}

interface VisibleUserText {
  readonly text: string;
  readonly transportWhitespacePrefixRemoved: boolean;
}

function visibleUserText(value: string): VisibleUserText {
  let visible = value
    .replace(/<codex_internal_context\b[^>]*>[\s\S]*?<\/codex_internal_context>/giu, "")
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/giu, "")
    .replace(/<environment_context\b[^>]*>[\s\S]*?<\/environment_context>/giu, "")
    .replace(/<recommended_plugins\b[^>]*>[\s\S]*?<\/recommended_plugins>/giu, "")
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/giu, "")
    .replace(/<app-context\b[^>]*>[\s\S]*?<\/app-context>/giu, "")
    .replace(/(?:^|\n)# Response annotations:[\s\S]*?<\/response-annotations>\s*/giu, "\n");
  visible = visible.replace(
    /<codex_delegation\b[^>]*>[\s\S]*?<input>([\s\S]*?)<\/input>[\s\S]*?<\/codex_delegation>/giu,
    "$1",
  );
  // Codex Desktop can persist one encoded leading U+0020 as the literal
  // transport prefix `&#x20;`. It is not part of the user's visible text. Keep
  // every other entity byte-for-byte; broad HTML decoding would corrupt code,
  // quoted evidence and intentional entity examples.
  const transportPrefix = /^(?:\s*&#x0*20;)+/iu.exec(visible);
  if (transportPrefix !== null) visible = visible.slice(transportPrefix[0].length);
  return {
    text: visible.trim(),
    transportWhitespacePrefixRemoved: transportPrefix !== null,
  };
}

function textParts(value: JsonValue | undefined): string[] {
  if (typeof value === "string") return value.length === 0 ? [] : [value];
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const part of value) {
    if (typeof part === "string") {
      if (part.length > 0) result.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    const text = stringValue(part.text) ?? stringValue(part.summary_text);
    if (text !== undefined) result.push(text);
  }
  return result;
}

function reasoningEvent(
  envelope: CodexEnvelope,
  sourceIndex: number | string,
  sequence: number,
): RawSessionEvent | undefined {
  if (envelope.payload.type !== "reasoning") return undefined;
  const content = [
    ...textParts(envelope.payload.summary),
    ...textParts(envelope.payload.content),
  ].join("\n").trim();
  if (content.length === 0) return undefined;
  return {
    sourceEventId: stringValue(envelope.payload.id) ?? `reasoning-${sourceIndex}`,
    parentSourceEventId: null,
    sequence,
    kind: "message",
    role: "assistant",
    content,
    attachments: [],
    extensions: { sourceType: "reasoning" },
  };
}

function messageEvent(
  envelope: CodexEnvelope,
  sourceIndex: number | string,
  sequence: number,
): RawSessionEvent | null | undefined {
  const payload = envelope.payload;
  if (payload.type !== "message" || typeof payload.role !== "string" || !Array.isArray(payload.content)) {
    return undefined;
  }
  const imported = typeof payload.dsh_import === "object" && payload.dsh_import !== null && !Array.isArray(payload.dsh_import)
    ? payload.dsh_import as Readonly<Record<string, JsonValue>>
    : undefined;
  const importedMode = imported?.mode;
  const role = importedMode === "visible-record"
    ? "tool"
    : importedMode === "metadata-record"
      ? "unknown"
      : ["user", "assistant", "system"].includes(payload.role)
    ? (payload.role as "user" | "assistant" | "system")
    : "unknown";
  const text: string[] = [];
  const attachments: AttachmentRef[] = [];
  const unknownContent: JsonValue[] = [];
  for (const part of payload.content) {
    if (
      typeof part === "object" &&
      part !== null &&
      !Array.isArray(part) &&
      "type" in part &&
      ["input_text", "output_text", "text"].includes(String(part.type)) &&
      "text" in part &&
      typeof part.text === "string"
    ) {
      text.push(part.text);
    } else if (
      typeof part === "object" &&
      part !== null &&
      !Array.isArray(part) &&
      "type" in part &&
      part.type === "input_image" &&
      "image_url" in part &&
      typeof part.image_url === "string"
    ) {
      attachments.push({ name: `codex-image-${attachments.length + 1}`, source: part.image_url });
    } else {
      unknownContent.push(asJson(part));
    }
  }

  const joinedContent = text.join("\n");
  const visibleUser = payload.role === "user" && imported === undefined
    ? visibleUserText(joinedContent)
    : undefined;
  const importedContent = importedMode === "visible-record" || importedMode === "metadata-record"
    ? joinedContent.replace(/^\[DSH 导入记录 · [^\]]+\]\n/u, "")
    : visibleUser !== undefined
      ? visibleUser.text
      : joinedContent;
  if (payload.role === "user"
    && imported === undefined
    && importedContent.length === 0
    && attachments.length === 0
    && unknownContent.length === 0) {
    return null;
  }
  return {
    sourceEventId:
      typeof payload.id === "string" && payload.id.length > 0 ? payload.id : `line-${sourceIndex}`,
    parentSourceEventId: null,
    sequence,
    kind: importedMode === "visible-record" ? "tool-import" : importedMode === "metadata-record" ? "metadata" : "message",
    role,
    content: importedContent,
    attachments,
    extensions: {
      ...(unknownContent.length === 0 ? {} : { unknownContent }),
      ...(imported === undefined ? {} : { dshImport: imported as JsonValue }),
      ...(visibleUser?.transportWhitespacePrefixRemoved === true
        ? { codexTextNormalization: { transportWhitespacePrefixRemoved: true } }
        : {}),
    },
  };
}

interface IndexedCodexEnvelope {
  readonly envelope: CodexEnvelope;
  readonly sourceIndex: number | string;
  readonly compactionBoundary?: true;
}

/**
 * Codex persists a `compacted` envelope whose `replacement_history` is the
 * model-visible history after compaction. Rows before that boundary remain in
 * the rollout for audit, but replaying them as active messages defeats Codex's
 * compaction and can make the first DSH continuation exceed the model window.
 */
function activeCodexEnvelopes(envelopes: readonly CodexEnvelope[]): readonly IndexedCodexEnvelope[] {
  let compactedIndex = -1;
  for (const [index, envelope] of envelopes.entries()) {
    if (envelope.type === "compacted" && Array.isArray(envelope.payload.replacement_history)) {
      compactedIndex = index;
    }
  }
  if (compactedIndex < 0) {
    return envelopes.map((envelope, sourceIndex) => ({ envelope, sourceIndex }));
  }

  const boundary = envelopes[compactedIndex]!;
  const replacementHistory = boundary.payload.replacement_history as readonly JsonValue[];
  const active: IndexedCodexEnvelope[] = [{
    envelope: boundary,
    sourceIndex: compactedIndex,
    compactionBoundary: true,
  }];
  for (const [replacementIndex, value] of replacementHistory.entries()) {
    if (!isRecord(value)) continue;
    // The encrypted Codex compaction item is source-specific and cannot be
    // replayed through a different provider. It remains available inside the
    // boundary evidence above; only portable response items become active.
    if (value.type === "compaction") continue;
    // Codex developer scaffolding is not a user/assistant turn and must not be
    // widened into a DSH conversation. The boundary evidence retains it.
    if (value.type === "message" && value.role === "developer") continue;
    active.push({
      envelope: {
        ...(boundary.timestamp === undefined ? {} : { timestamp: boundary.timestamp }),
        type: "response_item",
        payload: value,
      },
      sourceIndex: `${compactedIndex}:replacement:${replacementIndex}`,
    });
  }
  for (let index = compactedIndex + 1; index < envelopes.length; index += 1) {
    active.push({ envelope: envelopes[index]!, sourceIndex: index });
  }
  return active;
}

function preservedEnvelopeEvent(
  envelope: CodexEnvelope,
  sourceIndex: number | string,
  sequence: number,
): RawSessionEvent {
  return {
    sourceEventId: stringValue(envelope.payload.id) ?? `line-${sourceIndex}`,
    parentSourceEventId: null,
    sequence,
    kind: "metadata",
    role: "unknown",
    content: "",
    attachments: [],
    extensions: {
      sourceType: envelope.type,
      codexEnvelope: asJson(envelope),
    },
  };
}

interface CodexTurnAssignmentState {
  activeTurnId: string | null;
  activeTurnIsExplicit: boolean;
  currentConversationTurnId: string | null;
  readonly turnOrdinals: Map<string, number>;
}

function responseItemTurnId(payload: Readonly<Record<string, JsonValue>>): string | undefined {
  const metadata = payload.internal_chat_message_metadata_passthrough;
  return isRecord(metadata) ? stringValue(metadata.turn_id) : undefined;
}

function assignTopology(
  state: CodexTurnAssignmentState,
  payload: Readonly<Record<string, JsonValue>>,
  phase: CanonicalConversationPhase,
  sourceIndex: number | string,
): CanonicalConversationTopologyV1 {
  const payloadTurnId = responseItemTurnId(payload);
  let turnId = payloadTurnId ?? state.activeTurnId;
  let inference: CanonicalConversationTopologyV1["inference"] =
    payloadTurnId !== undefined || (turnId !== null && state.activeTurnIsExplicit) ? "explicit" : "derived";
  if (turnId === null && phase !== "user") turnId = state.currentConversationTurnId;
  if (turnId === null) {
    turnId = `codex-turn:${sourceIndex}`;
    inference = "derived";
  }
  state.currentConversationTurnId = turnId;
  let turnOrdinal = state.turnOrdinals.get(turnId);
  if (turnOrdinal === undefined) {
    turnOrdinal = state.turnOrdinals.size;
    state.turnOrdinals.set(turnId, turnOrdinal);
  }
  return {
    schemaVersion: 1,
    turnId,
    turnOrdinal,
    stepId: null,
    stepOrdinal: null,
    phase,
    inference,
  };
}

function withCanonicalSemantics(
  event: RawSessionEvent,
  semantics: CodexCanonicalSemanticsV1,
  topology?: CanonicalConversationTopologyV1,
): RawSessionEvent {
  return {
    ...event,
    role: semantics.role,
    extensions: {
      ...event.extensions,
      [CODEX_CANONICAL_SEMANTICS_EXTENSION]: semantics,
      ...(topology === undefined ? {} : { [CANONICAL_CONVERSATION_TOPOLOGY_EXTENSION]: topology }),
    },
  };
}

function canonicalSemantics(
  kind: CanonicalEventKind,
  role: CanonicalEventRole,
  sourceKind: string,
): CodexCanonicalSemanticsV1 {
  return codexCanonicalSemantics({
    disposition: "canonical",
    kind,
    role,
    sourceKind,
    otherReason: null,
  });
}

function otherSemantics(
  sourceKind: string,
  reason: "unsupported-source-event" | "orphan-tool-result" = "unsupported-source-event",
): CodexCanonicalSemanticsV1 {
  return codexCanonicalSemantics({
    disposition: "other",
    kind: "other",
    role: "unknown",
    sourceKind,
    otherReason: reason,
  });
}

function sourceKind(envelope: CodexEnvelope): string {
  const payloadType = stringValue(envelope.payload.type);
  return `codex/${envelope.type}${payloadType === undefined ? "" : `:${payloadType}`}`;
}

function updateTurnBoundaryBefore(
  state: CodexTurnAssignmentState,
  envelope: CodexEnvelope,
): void {
  if (envelope.type === "turn_context") {
    const turnId = stringValue(envelope.payload.turn_id);
    if (turnId !== undefined) {
      state.activeTurnId = turnId;
      state.activeTurnIsExplicit = true;
    }
    return;
  }
  if (envelope.type !== "event_msg") return;
  const type = stringValue(envelope.payload.type);
  if (type !== "task_started" && type !== "turn_started") return;
  const turnId = stringValue(envelope.payload.turn_id);
  if (turnId !== undefined) {
    state.activeTurnId = turnId;
    state.activeTurnIsExplicit = true;
  }
}

function updateTurnBoundaryAfter(
  state: CodexTurnAssignmentState,
  envelope: CodexEnvelope,
): void {
  if (envelope.type !== "event_msg") return;
  const type = stringValue(envelope.payload.type);
  if (type === "task_complete" || type === "turn_complete" || type === "turn_aborted") {
    state.activeTurnId = null;
    state.activeTurnIsExplicit = false;
  }
}

function classifyMessage(
  envelope: CodexEnvelope,
  sourceIndex: number | string,
  sequence: number,
  state: CodexTurnAssignmentState,
): { readonly event?: RawSessionEvent; readonly evidenceOnly: boolean; readonly other: boolean } | undefined {
  if (envelope.payload.type !== "message") return undefined;
  const parsed = messageEvent(envelope, sourceIndex, sequence);
  if (parsed === null) return { evidenceOnly: true, other: false };
  if (parsed === undefined) return undefined;
  if (parsed.extensions.dshImport !== undefined) {
    if (parsed.kind === "metadata") return { evidenceOnly: true, other: false };
    return {
      event: withCanonicalSemantics(parsed, otherSemantics("codex/response_item:dsh-import-visible-record")),
      evidenceOnly: false,
      other: true,
    };
  }
  if (parsed.role !== "user" && parsed.role !== "assistant") {
    return { evidenceOnly: true, other: false };
  }
  const phase = parsed.role === "user" ? "user" : "assistant";
  const kind = parsed.role === "user" ? "user-message" : "assistant-message";
  return {
    event: withCanonicalSemantics(
      parsed,
      canonicalSemantics(kind, parsed.role, "codex/response_item:message"),
      assignTopology(state, envelope.payload, phase, sourceIndex),
    ),
    evidenceOnly: false,
    other: false,
  };
}

export function normalizeCodexObservation(observation: StableObservation): CodexNormalizedSession {
  if (!isCodexObservationPayload(observation.payload)) {
    throw new TypeError("Stable observation is not a supported Codex payload");
  }
  const payload = observation.payload;
  const events: RawSessionEvent[] = [];
  const issues: CompatibilityIssue[] = [];
  const active = activeCodexEnvelopes(payload.envelopes);
  const sourceKindCounts: Record<string, number> = {};
  const turnState: CodexTurnAssignmentState = {
    activeTurnId: null,
    activeTurnIsExplicit: false,
    currentConversationTurnId: null,
    turnOrdinals: new Map(),
  };
  let canonicalEventCount = 0;
  let evidenceOnlyCount = 0;
  let otherEventCount = 0;
  for (const item of active) {
    const { envelope, sourceIndex } = item;
    const envelopeSourceKind = sourceKind(envelope);
    sourceKindCounts[envelopeSourceKind] = (sourceKindCounts[envelopeSourceKind] ?? 0) + 1;
    updateTurnBoundaryBefore(turnState, envelope);
    if (envelope.type === "session_meta") {
      evidenceOnlyCount += 1;
      continue;
    }
    if (item.compactionBoundary === true) {
      evidenceOnlyCount += 1;
      continue;
    }
    if (envelope.type === "response_item") {
      const message = classifyMessage(envelope, sourceIndex, events.length, turnState);
      if (message !== undefined) {
        if (message.event !== undefined) events.push(message.event);
        if (message.evidenceOnly) evidenceOnlyCount += 1;
        else if (message.other) otherEventCount += 1;
        else canonicalEventCount += 1;
        continue;
      }
      const tool = toolEvent(envelope, sourceIndex, events.length);
      if (tool !== undefined) {
        const codexTool = tool.extensions.codexTool;
        const phase = isRecord(codexTool) && codexTool.phase === "call" ? "tool-call" : "tool-result";
        events.push(withCanonicalSemantics(
          tool,
          canonicalSemantics(
            phase,
            phase === "tool-call" ? "assistant" : "tool",
            envelopeSourceKind,
          ),
          assignTopology(turnState, envelope.payload, phase, sourceIndex),
        ));
        canonicalEventCount += 1;
        continue;
      }
      const reasoning = reasoningEvent(envelope, sourceIndex, events.length);
      if (reasoning !== undefined) {
        events.push(withCanonicalSemantics(
          reasoning,
          canonicalSemantics("reasoning", "assistant", envelopeSourceKind),
          assignTopology(turnState, envelope.payload, "reasoning", sourceIndex),
        ));
        canonicalEventCount += 1;
        continue;
      }
      if (envelope.payload.type === "reasoning") {
        evidenceOnlyCount += 1;
        continue;
      }
    }
    if (["event_msg", "turn_context", "token_usage_record", "world_state", "compacted"].includes(envelope.type)) {
      evidenceOnlyCount += 1;
      updateTurnBoundaryAfter(turnState, envelope);
      continue;
    }

    const reason = envelope.type === "response_item"
      && (envelope.payload.type === "custom_tool_call_output" || envelope.payload.type === "function_call_output")
      ? "orphan-tool-result"
      : "unsupported-source-event";
    events.push(withCanonicalSemantics(
      preservedEnvelopeEvent(envelope, sourceIndex, events.length),
      otherSemantics(envelopeSourceKind, reason),
    ));
    otherEventCount += 1;
    issues.push({
      code: "CODEX_EVENT_DEGRADED",
      message: `Unsupported Codex envelope preserved as Adapter evidence: ${envelopeSourceKind}`,
      sourceType: envelopeSourceKind,
    });
    updateTurnBoundaryAfter(turnState, envelope);
  }

  const normalized = normalizeSession({
    key: observation.key,
    title: codexDisplayTitle(payload.thread),
    archived: Boolean(payload.thread.archived),
    workspaceId: codexWorkspaceId(payload.thread.cwd),
    provenance: {
      ...observation.key,
      observedAt: new Date(payload.thread.updated_at_ms ?? payload.thread.updated_at * 1000).toISOString(),
      sourceVersion: "0.146.0",
    },
    compatibility: { status: issues.length === 0 ? "compatible" : "degraded", issues },
    events,
  });
  const codexClassification: CodexClassificationSummaryV1 = {
    schemaVersion: 1,
    sourceEnvelopeCount: active.length,
    canonicalEventCount,
    evidenceOnlyCount,
    otherEventCount,
    transportWhitespaceNormalizedEventCount: events.filter((event) =>
      isRecord(event.extensions.codexTextNormalization)
      && event.extensions.codexTextNormalization.transportWhitespacePrefixRemoved === true).length,
    sourceKindCounts,
  };
  return { ...normalized, codexClassification };
}
