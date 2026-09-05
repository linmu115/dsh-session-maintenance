import { createHash } from "node:crypto";

import {
  canonicalEventProjectionPolicy,
  readCanonicalConversationTopologyV1,
} from "@linmu/dsh-session-adapter-sdk";
import type {
  CanonicalConversationTopologyV1,
  CanonicalEventV1,
  CanonicalProjectionInput,
  CanonicalProjectionSessionInput,
  JsonValue,
  LogicalSessionId,
  NativeSessionId,
  ProjectionManifest,
  ProjectionManifestCompositionInput,
  ProjectionWriter,
} from "@linmu/dsh-session-adapter-sdk";

import { manifest } from "./manifest.js";
import {
  rc1SessionLogOffset,
  rc1SessionSeq,
  type Rc1SessionLogOffset,
  type Rc1SessionSeq,
} from "./native-types.js";

export interface Rc1SessionEvent {
  readonly type: string;
  readonly seq: Rc1SessionSeq;
  readonly time: number;
  readonly data: JsonValue;
  readonly ignorable?: true;
  readonly sourceEventSeqs?: readonly Rc1SessionSeq[];
  readonly surfaceOp?: JsonValue;
}

export interface Rc1ProjectionSession {
  readonly schemaVersion: 1;
  readonly logicalSessionId: LogicalSessionId;
  readonly baseVersionId: string | null;
  readonly projectId: string | null;
  readonly projectTitle: string | null;
  readonly workspaceId: string | null;
  /** Canonical catalog ordering timestamp, independent from the native header. */
  readonly updatedAt: string;
  readonly title: string;
  readonly tags: readonly string[];
  /** Determines whether later RC1 appends remain native or extend portable MCSF history. */
  readonly canonicalHistoryMode: "native" | "portable";
  /** Projection-local aliases; never part of model-facing SessionEvents. */
  readonly anchorAliases?: Readonly<Record<string, string>>;
  /** Exact fork-inherited prefix length carried outside the RC1 SessionHeader. */
  readonly inheritedEventCount: Rc1SessionLogOffset;
  readonly header: {
    readonly version: 0;
    readonly id: NativeSessionId;
    readonly createdAt: number;
    readonly delegationDepth: 0;
    readonly isSeeded: false;
    readonly cwd?: string;
  };
  readonly events: readonly Rc1SessionEvent[];
}

export function rc1NativeSessionId(logicalSessionId: LogicalSessionId): NativeSessionId {
  const encoded = Buffer.from(logicalSessionId, "utf8").toString("base64url");
  return `dsh-maintenance_${encoded}` as NativeSessionId;
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function digest(value: JsonValue): string {
  const bytes = JSON.stringify(canonicalize(value));
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

function isRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function diagnosticMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown materialization failure";
}

function decodeSourceEventSeqs(value: JsonValue, eventSeq: number): readonly Rc1SessionSeq[] {
  if (!Array.isArray(value)) throw new TypeError("Rc1 sourceEventSeqs must be an array");
  const decoded: Rc1SessionSeq[] = [];
  let hasRange = false;
  for (const entry of value) {
    if (typeof entry === "number") {
      if (!Number.isSafeInteger(entry) || entry < 0 || decoded.length >= eventSeq) {
        throw new TypeError("Rc1 sourceEventSeqs contains an invalid sequence");
      }
      decoded.push(rc1SessionSeq(entry));
      continue;
    }
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError("Rc1 sourceEventSeqs range must be [start, end]");
    }
    const [start, end] = entry;
    if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end) || start < 0 || end < start || end - start + 1 > eventSeq - decoded.length) {
      throw new TypeError("Rc1 sourceEventSeqs contains an invalid range");
    }
    for (let sequence = start; sequence <= end; sequence += 1) decoded.push(rc1SessionSeq(sequence));
    hasRange = true;
  }
  if (hasRange && decoded.some((sequence, index) => index > 0 && sequence <= decoded[index - 1]!)) {
    throw new TypeError("Rc1 sourceEventSeqs ranges must be strictly increasing");
  }
  return decoded;
}

function packedStorageEvents(event: CanonicalEventV1): readonly Rc1SessionEvent[] | undefined {
  if (!isRecord(event.rawPayload)) return undefined;
  const raw = event.rawPayload;
  const tag = raw.type;
  if (tag !== "text-chunks" && tag !== "reasoning-chunks" && tag !== "tool-call-chunks") return undefined;
  if (typeof raw.time !== "number" || !Number.isSafeInteger(raw.time) || !isRecord(raw.data)) {
    throw new TypeError(`Malformed Rc1 ${tag} canonical storage row`);
  }
  const data = raw.data;
  const payloadKey = tag === "tool-call-chunks" ? "args" : "texts";
  const payload = data[payloadKey];
  if (typeof data.turn !== "number" || typeof data.step !== "number" || typeof data.index !== "number"
    || !Array.isArray(payload) || payload.length === 0 || payload.some((entry) => typeof entry !== "string")
    || !Array.isArray(data.dt) || data.dt.some((entry) => !Number.isSafeInteger(entry))
    || data.dt.length !== payload.length - 1
    || (tag === "tool-call-chunks" && (typeof data.id !== "string"
      || (data.name !== undefined && typeof data.name !== "string")))) {
    throw new TypeError(`Malformed Rc1 ${tag} canonical storage row`);
  }
  if (payload.length - 1 > Number.MAX_SAFE_INTEGER - event.sequence) {
    throw new TypeError(`Rc1 ${tag} canonical storage row exceeds safe event sequences`);
  }
  const output: Rc1SessionEvent[] = [];
  let time = Number(raw.time);
  for (let index = 0; index < payload.length; index += 1) {
    if (index > 0) time += Number(data.dt[index - 1]!);
    if (!Number.isSafeInteger(time)) throw new TypeError(`Rc1 ${tag} canonical storage row has an invalid time`);
    const chunk = tag === "text-chunks"
      ? { type: "text-delta", index: data.index, text: payload[index]! }
      : tag === "reasoning-chunks"
        ? { type: "reasoning-delta", index: data.index, text: payload[index]! }
        : {
            type: "tool-call-delta",
            index: data.index,
            id: data.id!,
            ...(data.name === undefined ? {} : { name: data.name }),
            argumentsDelta: payload[index]!,
          };
    output.push({
      type: "assistant/chunk",
      seq: rc1SessionSeq(event.sequence + index),
      time,
      data: { turn: data.turn, step: data.step, chunk },
    });
  }
  return output;
}

function rawEnvelope(event: CanonicalEventV1): Rc1SessionEvent | undefined {
  if (!isRecord(event.rawPayload)) return undefined;
  const raw = event.rawPayload;
  if (typeof raw.type !== "string" || !Number.isSafeInteger(raw.seq) || !Number.isSafeInteger(raw.time) || !("data" in raw)) {
    return undefined;
  }
  const output: Rc1SessionEvent = {
    type: raw.type,
    seq: rc1SessionSeq(event.sequence),
    time: raw.time as number,
    data: raw.data as JsonValue,
    ...(raw.ignorable === true ? { ignorable: true as const } : {}),
    ...(raw.sourceEventSeqs === undefined
      ? {}
      : { sourceEventSeqs: decodeSourceEventSeqs(raw.sourceEventSeqs, event.sequence) }),
    ...(raw.surfaceOp !== undefined ? { surfaceOp: raw.surfaceOp } : {}),
  };
  return output;
}

function nonEmptyString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function canonicalMessageRecord(event: CanonicalEventV1): { readonly [key: string]: JsonValue } | undefined {
  if (!isRecord(event.content)) return undefined;
  return isRecord(event.content.message) ? event.content.message : event.content;
}

function attachmentLabel(value: JsonValue): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!isRecord(value)) return undefined;
  return nonEmptyString(value.name)
    ?? nonEmptyString(value.path)
    ?? nonEmptyString(value.source)
    ?? nonEmptyString(value.url);
}

function canonicalMessageBlocks(event: CanonicalEventV1): readonly JsonValue[] {
  const message = canonicalMessageRecord(event);
  if (Array.isArray(message?.content)) return message.content;

  const blocks: JsonValue[] = [];
  const text = nonEmptyString(message?.text)
    ?? (typeof event.content === "string" ? event.content : undefined);
  if (text !== undefined) blocks.push({ type: "text", text });

  const attachments = message?.attachments;
  if (Array.isArray(attachments)) {
    const labels = attachments.map(attachmentLabel).filter((value): value is string => value !== undefined);
    if (labels.length > 0) {
      blocks.push({ type: "text", text: `\n\n附件：${labels.join("、")}` });
    }
  }

  // Rc1 requires an array but accepts an empty textual message. Keeping one
  // block also gives imported metadata-only turns a stable surface node.
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

function rc1Message(
  event: CanonicalEventV1,
  role: "user" | "assistant",
): { readonly [key: string]: JsonValue } {
  const existing = canonicalMessageRecord(event);
  const existingSource = isRecord(existing?.source) ? existing.source : undefined;
  const source = role === "assistant"
    && existingSource?.kind === "model"
    && nonEmptyString(existingSource.provider) !== undefined
    && nonEmptyString(existingSource.model) !== undefined
    ? existingSource
    : role === "assistant"
      ? { kind: "model", provider: "codex", model: "imported" }
      : { kind: "user" };
  return {
    id: nonEmptyString(existing?.id) ?? event.id,
    role,
    content: canonicalMessageBlocks(event),
    source,
  };
}

function canonicalToolRecord(event: CanonicalEventV1): { readonly [key: string]: JsonValue } {
  return isRecord(event.content) ? event.content : {};
}

function canonicalToolCall(
  event: CanonicalEventV1,
  turn = 0,
  step = 0,
): { readonly [key: string]: JsonValue } {
  const content = canonicalToolRecord(event);
  return {
    turn,
    step,
    callId: nonEmptyString(content.callId) ?? event.id,
    name: nonEmptyString(content.name) ?? "codex-tool",
    arguments: typeof content.arguments === "string" ? content.arguments : "",
  };
}

function canonicalToolCallMessage(
  event: CanonicalEventV1,
  turn = 0,
  step = 0,
): { readonly [key: string]: JsonValue } {
  const call = canonicalToolCall(event, turn, step);
  return {
    turn: call.turn!,
    step: call.step!,
    message: {
      id: `${event.id}:assistant-tool-call`,
      role: "assistant",
      content: [{
        type: "tool-call",
        id: call.callId!,
        name: call.name!,
        arguments: call.arguments!,
      }],
      source: { kind: "model", provider: "codex", model: "imported" },
    },
  };
}

function canonicalToolResult(
  event: CanonicalEventV1,
  turn = 0,
  step = 0,
): { readonly [key: string]: JsonValue } {
  const content = canonicalToolRecord(event);
  const callId = nonEmptyString(content.callId) ?? event.id;
  const text = typeof content.outputText === "string" ? content.outputText : "";
  const isError = content.isError === true;
  return {
    turn,
    step,
    message: {
      id: event.id,
      role: "user",
      content: [{
        type: "tool-result",
        toolCallId: callId,
        content: [{ type: "text", text }],
        ...(isError ? { isError: true } : {}),
      }],
      source: { kind: "tool", callId },
    },
    meta: {
      importedFrom: "codex",
      name: nonEmptyString(content.name) ?? "codex-tool",
      protocol: nonEmptyString(content.protocol) ?? "unknown",
    },
  };
}

function materializeEvent(event: CanonicalEventV1, createdAt: number): Rc1SessionEvent {
  // MCSF `other` is a hard safety boundary. Adapter evidence may contain a
  // source event that happens to look like a model-facing Rc1 message, but
  // replaying that envelope would widen log-only evidence into model history.
  const raw = event.kind === "other" ? undefined : rawEnvelope(event);
  if (raw !== undefined) return raw;
  const time = createdAt + event.sequence;
  if (event.kind === "user-message") {
    return {
      type: "user/message",
      seq: rc1SessionSeq(event.sequence),
      time,
      data: rc1Message(event, "user"),
      surfaceOp: "append",
    };
  }
  if (event.kind === "assistant-message") {
    const envelope = isRecord(event.content) && isRecord(event.content.message) ? event.content : undefined;
    return {
      type: "assistant/message",
      seq: rc1SessionSeq(event.sequence),
      time,
      data: {
        turn: typeof envelope?.turn === "number" ? envelope.turn : 0,
        step: typeof envelope?.step === "number" ? envelope.step : 0,
        message: rc1Message(event, "assistant"),
      },
      surfaceOp: "append",
    };
  }
  if (event.kind === "tool-call") {
    return {
      type: "tool/call",
      seq: rc1SessionSeq(event.sequence),
      time,
      data: canonicalToolCall(event),
    };
  }
  if (event.kind === "tool-result") {
    return {
      type: "tool/result",
      seq: rc1SessionSeq(event.sequence),
      time,
      data: canonicalToolResult(event),
      surfaceOp: "append",
    };
  }
  const policy = event.kind === "other" ? canonicalEventProjectionPolicy(event.kind) : undefined;
  return {
    type: event.kind === "other" ? "maintenance/other" : `maintenance/${event.kind}`,
    seq: rc1SessionSeq(event.sequence),
    time,
    data: {
      canonicalContent: event.content,
      extensions: event.extensions,
      ...(policy === undefined ? {} : policy),
    },
    ignorable: true,
  };
}

interface MaterializedDraft {
  readonly event: Rc1SessionEvent;
  /** Original Rc1 sequence represented by this row; absent for inserted rows. */
  readonly originSequence?: number;
  /** Present only for a synthesized Codex tool result. */
  readonly resultCallId?: string;
}

function rebaseSurfaceOp(surfaceOp: JsonValue, sequenceMap: ReadonlyMap<number, number>): JsonValue {
  if (!isRecord(surfaceOp) || surfaceOp.op !== "replace") return surfaceOp;
  const start = surfaceOp.start;
  const end = surfaceOp.end;
  return {
    ...surfaceOp,
    ...(typeof start === "number" && sequenceMap.has(start) ? { start: sequenceMap.get(start)! } : {}),
    ...(typeof end === "number" && sequenceMap.has(end) ? { end: sequenceMap.get(end)! } : {}),
  };
}

function materializeNativeEnvelopeEvents(
  events: readonly CanonicalEventV1[],
  createdAt: number,
): readonly Rc1SessionEvent[] {
  const drafts: MaterializedDraft[] = [];
  for (const event of events) {
    const packed = event.kind === "other" ? undefined : packedStorageEvents(event);
    if (packed !== undefined) {
      drafts.push(...packed.map((item) => ({ event: item, originSequence: item.seq })));
      continue;
    }

    const raw = event.kind === "other" ? undefined : rawEnvelope(event);
    if (raw === undefined && event.kind === "tool-call") {
      const call = canonicalToolCall(event);
      drafts.push({
        event: {
          type: "assistant/message",
          seq: rc1SessionSeq(event.sequence),
          time: createdAt + event.sequence,
          data: canonicalToolCallMessage(event),
          surfaceOp: "append",
        },
      });
      drafts.push({ event: materializeEvent(event, createdAt), originSequence: event.sequence });
      continue;
    }

    const materialized = raw ?? materializeEvent(event, createdAt);
    const content = raw === undefined && event.kind === "tool-result" ? canonicalToolRecord(event) : undefined;
    drafts.push({
      event: materialized,
      originSequence: event.sequence,
      ...(content === undefined ? {} : { resultCallId: nonEmptyString(content.callId) ?? event.id }),
    });
  }

  const sequenceMap = new Map<number, number>();
  let previousOrigin = -1;
  for (const [newSequence, draft] of drafts.entries()) {
    if (draft.originSequence === undefined) continue;
    if (draft.originSequence <= previousOrigin) {
      throw new TypeError(
        `Rc1 projection event sequence is not strictly increasing: ${String(previousOrigin)} -> ${String(draft.originSequence)}`,
      );
    }
    sequenceMap.set(draft.originSequence, newSequence);
    previousOrigin = draft.originSequence;
  }

  const callSequenceById = new Map<string, number>();
  for (const [newSequence, draft] of drafts.entries()) {
    if (draft.event.type !== "tool/call" || !isRecord(draft.event.data)) continue;
    const callId = nonEmptyString(draft.event.data.callId);
    if (callId !== undefined) callSequenceById.set(callId, newSequence);
  }

  return drafts.map((draft, newSequence) => {
    const sourceEventSeqs = draft.event.sourceEventSeqs?.map((sequence) => {
      const rebased = sequenceMap.get(sequence);
      if (rebased === undefined) {
        throw new TypeError(`Rc1 projection source sequence ${sequence} has no materialized target`);
      }
      return rc1SessionSeq(rebased);
    });
    if (draft.resultCallId !== undefined) {
      const callSequence = callSequenceById.get(draft.resultCallId);
      if (callSequence === undefined) {
        return {
          type: "maintenance/orphan-tool-result",
          seq: rc1SessionSeq(newSequence),
          time: draft.event.time,
          data: {
            reason: "missing-correlated-tool-call",
            callId: draft.resultCallId,
            canonicalResult: draft.event.data,
          },
          ignorable: true as const,
        };
      }
      return {
        ...draft.event,
        seq: rc1SessionSeq(newSequence),
        sourceEventSeqs: [rc1SessionSeq(callSequence)],
        ...(draft.event.surfaceOp === undefined
          ? {}
          : { surfaceOp: rebaseSurfaceOp(draft.event.surfaceOp, sequenceMap) }),
      };
    }
    return {
      ...draft.event,
      seq: rc1SessionSeq(newSequence),
      ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
      ...(draft.event.surfaceOp === undefined
        ? {}
        : { surfaceOp: rebaseSurfaceOp(draft.event.surfaceOp, sequenceMap) }),
    };
  });
}

type PortableConversationKind = Extract<CanonicalEventV1["kind"],
  "user-message" | "reasoning" | "assistant-message" | "tool-call" | "tool-result">;

interface TopologizedEvent {
  readonly event: CanonicalEventV1;
  readonly topology: CanonicalConversationTopologyV1;
}

interface PortableTurn {
  readonly id: string;
  readonly ordinal: number;
  readonly events: TopologizedEvent[];
}

interface PortableStep {
  readonly id: string;
  readonly ordinal: number;
  readonly events: TopologizedEvent[];
}

interface PortableOtherGroup {
  readonly events: readonly CanonicalEventV1[];
}

interface PositionedDraft {
  readonly sourceSequence: number;
  readonly rank: number;
  readonly insertionOrder: number;
  readonly event: Rc1SessionEvent;
  readonly originSequences: readonly number[];
  readonly resultCallId?: string;
}

function conversationPhaseForKind(
  kind: CanonicalEventV1["kind"],
): CanonicalConversationTopologyV1["phase"] | null {
  if (kind === "user-message") return "user";
  if (kind === "reasoning") return "reasoning";
  if (kind === "assistant-message") return "assistant";
  if (kind === "tool-call") return "tool-call";
  if (kind === "tool-result") return "tool-result";
  return null;
}

function isPortableConversationKind(kind: CanonicalEventV1["kind"]): kind is PortableConversationKind {
  return conversationPhaseForKind(kind) !== null;
}

function strictCallId(event: CanonicalEventV1): string | null {
  const value = canonicalToolRecord(event).callId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sameCoordinates(left: TopologizedEvent, right: TopologizedEvent): boolean {
  return left.topology.turnId === right.topology.turnId
    && left.topology.stepId !== null
    && left.topology.stepId === right.topology.stepId;
}

function reasoningBlocks(event: CanonicalEventV1): readonly JsonValue[] {
  return canonicalMessageBlocks(event).map((block) => {
    if (isRecord(block) && block.type === "reasoning") return block;
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      return { type: "reasoning", text: block.text };
    }
    throw new TypeError(`Portable reasoning event ${event.id} contains a non-text block`);
  });
}

function assistantSource(events: readonly TopologizedEvent[]): JsonValue {
  for (const { event } of events) {
    if (event.kind !== "assistant-message" && event.kind !== "reasoning") continue;
    const message = canonicalMessageRecord(event);
    const source = isRecord(message?.source) ? message.source : undefined;
    if (
      source?.kind === "model"
      && nonEmptyString(source.provider) !== undefined
      && nonEmptyString(source.model) !== undefined
    ) return source;
  }
  return { kind: "model", provider: "codex", model: "imported" };
}

function assistantContentBlocks(
  events: readonly TopologizedEvent[],
  matchedToolCallEventIds: ReadonlySet<string>,
): readonly JsonValue[] {
  const blocks: JsonValue[] = [];
  for (const { event } of events) {
    if (event.kind === "reasoning") {
      blocks.push(...reasoningBlocks(event));
      continue;
    }
    if (event.kind === "assistant-message") {
      const messageBlocks = canonicalMessageBlocks(event);
      if (messageBlocks.some((block) =>
        isRecord(block) && (block.type === "tool-call" || block.type === "tool-result"))) {
        throw new TypeError(
          `Portable assistant event ${event.id} embeds tool protocol blocks; use canonical tool events`,
        );
      }
      blocks.push(...messageBlocks);
      continue;
    }
    if (event.kind !== "tool-call" || !matchedToolCallEventIds.has(event.id)) continue;
    const call = canonicalToolRecord(event);
    const callId = strictCallId(event);
    const name = nonEmptyString(call.name);
    if (callId === null || name === undefined || typeof call.arguments !== "string") {
      throw new TypeError(`Portable tool call ${event.id} lacks its exact call_id, name or arguments`);
    }
    blocks.push({ type: "tool-call", id: callId, name, arguments: call.arguments });
  }
  return blocks;
}

function evidenceEvent(
  event: CanonicalEventV1,
  type: "maintenance/unclosed-tool-call" | "maintenance/orphan-tool-result",
  reason: string,
  createdAt: number,
): Rc1SessionEvent {
  return {
    type,
    seq: rc1SessionSeq(0),
    time: createdAt + event.sequence,
    data: {
      reason,
      callId: strictCallId(event),
      canonicalEventId: event.id,
      canonicalContent: event.content,
    },
    ignorable: true,
  };
}

function validateCanonicalSequence(events: readonly CanonicalEventV1[]): void {
  let previous = -1;
  const ids = new Set<string>();
  for (const event of events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 0 || event.sequence <= previous) {
      throw new TypeError(
        `Canonical projection event sequence is not strictly increasing: ${String(previous)} -> ${String(event.sequence)}`,
      );
    }
    if (ids.has(event.id)) throw new TypeError(`Canonical projection repeats event ID ${event.id}`);
    ids.add(event.id);
    previous = event.sequence;
  }
}

function collectPortableTurns(events: readonly CanonicalEventV1[]): readonly PortableTurn[] {
  const turnsById = new Map<string, PortableTurn>();
  const turnIdsByOrdinal = new Map<number, string>();
  for (const event of events) {
    const phase = conversationPhaseForKind(event.kind);
    if (phase === null) continue;
    const topology = readCanonicalConversationTopologyV1(event);
    if (topology === null) {
      throw new TypeError(
        `Portable conversation event ${event.id} lacks mcsf.conversationTopology.v1`,
      );
    }
    if (topology.phase !== phase) {
      throw new TypeError(`Portable conversation event ${event.id} has a mismatched topology phase`);
    }
    const ordinalId = turnIdsByOrdinal.get(topology.turnOrdinal);
    if (ordinalId !== undefined && ordinalId !== topology.turnId) {
      throw new TypeError(`Canonical turn ordinal ${topology.turnOrdinal} has conflicting identities`);
    }
    turnIdsByOrdinal.set(topology.turnOrdinal, topology.turnId);
    let turn = turnsById.get(topology.turnId);
    if (turn === undefined) {
      turn = { id: topology.turnId, ordinal: topology.turnOrdinal, events: [] };
      turnsById.set(topology.turnId, turn);
    } else if (turn.ordinal !== topology.turnOrdinal) {
      throw new TypeError(`Canonical turn ${topology.turnId} changes ordinal`);
    }
    turn.events.push({ event, topology });
  }

  const turns = [...turnsById.values()].sort((left, right) => left.ordinal - right.ordinal);
  let priorMaximum = -1;
  for (const [index, turn] of turns.entries()) {
    if (turn.ordinal !== index) {
      throw new TypeError(`Canonical turn ordinals must be dense from zero; saw ${turn.ordinal} at ${index}`);
    }
    const minimum = turn.events[0]!.event.sequence;
    const maximum = turn.events.at(-1)!.event.sequence;
    if (minimum <= priorMaximum) throw new TypeError(`Canonical turn ${turn.id} is not contiguous`);
    priorMaximum = maximum;
  }
  return turns;
}

function collectPortableSteps(turn: PortableTurn): readonly PortableStep[] {
  const stepsById = new Map<string, PortableStep>();
  const stepIdsByOrdinal = new Map<number, string>();
  for (const entry of turn.events) {
    if (entry.event.kind === "user-message") continue;
    const { stepId, stepOrdinal } = entry.topology;
    if (stepId === null || stepOrdinal === null) {
      throw new TypeError(`Canonical model event ${entry.event.id} lacks a step coordinate`);
    }
    const ordinalId = stepIdsByOrdinal.get(stepOrdinal);
    if (ordinalId !== undefined && ordinalId !== stepId) {
      throw new TypeError(`Canonical step ordinal ${stepOrdinal} has conflicting identities in ${turn.id}`);
    }
    stepIdsByOrdinal.set(stepOrdinal, stepId);
    let step = stepsById.get(stepId);
    if (step === undefined) {
      step = { id: stepId, ordinal: stepOrdinal, events: [] };
      stepsById.set(stepId, step);
    } else if (step.ordinal !== stepOrdinal) {
      throw new TypeError(`Canonical step ${stepId} changes ordinal`);
    }
    step.events.push(entry);
  }
  const steps = [...stepsById.values()].sort((left, right) => left.ordinal - right.ordinal);
  let priorMaximum = -1;
  for (const [index, step] of steps.entries()) {
    if (step.ordinal !== index) {
      throw new TypeError(
        `Canonical step ordinals in turn ${turn.id} must be dense from zero; saw ${step.ordinal} at ${index}`,
      );
    }
    const minimum = step.events[0]!.event.sequence;
    const maximum = step.events.at(-1)!.event.sequence;
    if (minimum <= priorMaximum) throw new TypeError(`Canonical step ${step.id} is not contiguous`);
    priorMaximum = maximum;
  }
  return steps;
}

function collectPortableOtherGroups(
  events: readonly CanonicalEventV1[],
  turns: readonly PortableTurn[],
): readonly PortableOtherGroup[] {
  const turnIntervals = turns.map((turn) => ({
    id: turn.id,
    minimum: turn.events[0]!.event.sequence,
    maximum: turn.events.at(-1)!.event.sequence,
  }));
  const groups: CanonicalEventV1[][] = [];
  const groupByTurnId = new Map<string, CanonicalEventV1[]>();
  let outsideGroup: CanonicalEventV1[] | null = null;
  for (const event of events) {
    if (event.kind !== "other") {
      outsideGroup = null;
      continue;
    }
    const turn = turnIntervals.find((candidate) =>
      event.sequence >= candidate.minimum && event.sequence <= candidate.maximum);
    if (turn !== undefined) {
      let group = groupByTurnId.get(turn.id);
      if (group === undefined) {
        group = [];
        groupByTurnId.set(turn.id, group);
        groups.push(group);
      }
      group.push(event);
      outsideGroup = null;
      continue;
    }
    if (outsideGroup === null) {
      outsideGroup = [];
      groups.push(outsideGroup);
    }
    outsideGroup.push(event);
  }
  return groups
    .filter((group) => group.length > 0)
    .sort((left, right) => left[0]!.sequence - right[0]!.sequence)
    .map((group) => ({ events: group }));
}

function groupedOtherEvent(group: PortableOtherGroup, createdAt: number): Rc1SessionEvent {
  if (group.events.length === 1) return materializeEvent(group.events[0]!, createdAt);
  const items = group.events.map((event) => {
    const content = isRecord(event.content) ? event.content : {};
    return {
      canonicalEventId: event.id,
      canonicalSequence: event.sequence,
      sourceKind: nonEmptyString(content.sourceKind) ?? "unknown",
      reason: nonEmptyString(content.reason) ?? "adapter-evidence",
      label: nonEmptyString(content.label) ?? "未映射记录",
      summary: nonEmptyString(content.summary) ?? "该记录没有可移植的公共语义。",
      evidenceRef: typeof content.evidenceRef === "string" ? content.evidenceRef : null,
    };
  });
  const sourceKinds = [...new Set(items.map((item) => item.sourceKind))];
  const first = group.events[0]!;
  return {
    type: "maintenance/other",
    seq: rc1SessionSeq(0),
    time: createdAt + first.sequence,
    data: {
      canonicalContent: {
        schemaVersion: 1,
        type: "other",
        reason: "adapter-evidence",
        sourceKind: "maintenance/grouped-other",
        label: `未映射记录（${group.events.length} 条）`,
        summary: `此处 ${group.events.length} 条源记录无法无损翻译，已合并为一条折叠维护记录。`,
        evidenceRef: null,
      },
      grouping: {
        schemaVersion: 1,
        count: group.events.length,
        firstCanonicalSequence: first.sequence,
        lastCanonicalSequence: group.events.at(-1)!.sequence,
        sourceKinds,
        items,
      },
      ...canonicalEventProjectionPolicy("other"),
      collapsed: true,
    },
    ignorable: true,
  };
}

function materializePortableConversationEvents(
  events: readonly CanonicalEventV1[],
  createdAt: number,
  anchorAliases: Map<string, string>,
): readonly Rc1SessionEvent[] {
  validateCanonicalSequence(events);
  const turns = collectPortableTurns(events);
  const topologized = turns.flatMap((turn) => turn.events);
  const callsById = new Map<string, TopologizedEvent[]>();
  const resultsById = new Map<string, TopologizedEvent[]>();
  for (const entry of topologized) {
    if (entry.event.kind !== "tool-call" && entry.event.kind !== "tool-result") continue;
    const callId = strictCallId(entry.event);
    if (callId === null) continue;
    const target = entry.event.kind === "tool-call" ? callsById : resultsById;
    const matches = target.get(callId) ?? [];
    matches.push(entry);
    target.set(callId, matches);
  }

  const matchedToolCallEventIds = new Set<string>();
  const matchedToolResultEventIds = new Set<string>();
  for (const [callId, calls] of callsById) {
    const results = resultsById.get(callId) ?? [];
    if (calls.length !== 1 || results.length !== 1 || !sameCoordinates(calls[0]!, results[0]!)) continue;
    matchedToolCallEventIds.add(calls[0]!.event.id);
    matchedToolResultEventIds.add(results[0]!.event.id);
  }

  const drafts: PositionedDraft[] = [];
  const eventsBySequence = new Map(events.map((event) => [event.sequence, event]));
  const messageIds = new Set<string>();
  const addAnchorAlias = (alias: string, messageId: string): void => {
    const existing = anchorAliases.get(alias);
    if (existing !== undefined && existing !== messageId) {
      throw new TypeError(`Rc1 portable projection has ambiguous message anchor ${alias}`);
    }
    anchorAliases.set(alias, messageId);
  };
  let insertionOrder = 0;
  const push = (
    sourceSequence: number,
    rank: number,
    event: Rc1SessionEvent,
    originSequences: readonly number[] = [],
    resultCallId?: string,
  ): void => {
    if (event.surfaceOp === "append"
      && (event.type === "user/message" || event.type === "assistant/message" || event.type === "tool/result")) {
      const data = isRecord(event.data) ? event.data : undefined;
      const message = event.type === "user/message" ? data
        : isRecord(data?.message) ? data.message : undefined;
      const messageId = nonEmptyString(message?.id);
      if (messageId === undefined) throw new TypeError("Rc1 portable projection has an empty message ID");
      if (messageIds.has(messageId)) throw new TypeError(`Rc1 portable projection repeats message ID ${messageId}`);
      messageIds.add(messageId);
      // Reserve actual identities too, so an alias can never redirect another
      // real message. Ambiguity is rejected rather than silently renamed.
      addAnchorAlias(messageId, messageId);
      for (const sequence of originSequences) {
        const origin = eventsBySequence.get(sequence)!;
        addAnchorAlias(origin.id, messageId);
        const historicalId = nonEmptyString(canonicalMessageRecord(origin)?.id);
        if (historicalId !== undefined) addAnchorAlias(historicalId, messageId);
      }
    }
    drafts.push({
      sourceSequence,
      rank,
      insertionOrder,
      event,
      originSequences,
      ...(resultCallId === undefined ? {} : { resultCallId }),
    });
    insertionOrder += 1;
  };

  const otherGroups = collectPortableOtherGroups(events, turns);
  for (const group of otherGroups) {
    const first = group.events[0]!;
    push(
      first.sequence,
      0,
      groupedOtherEvent(group, createdAt),
      group.events.map((event) => event.sequence),
    );
  }
  for (const event of events) {
    if (isPortableConversationKind(event.kind) || event.kind === "other") continue;
    push(event.sequence, 0, materializeEvent(event, createdAt), [event.sequence]);
  }

  for (const turn of turns) {
    const nativeTurn = turn.ordinal + 1;
    const firstSequence = turn.events[0]!.event.sequence;
    const lastSequence = turn.events.at(-1)!.event.sequence;
    push(firstSequence, -400, {
      type: "turn/start",
      seq: rc1SessionSeq(0),
      time: createdAt + firstSequence,
      data: { turn: nativeTurn },
    });

    for (const entry of turn.events) {
      if (entry.event.kind !== "user-message") continue;
      push(entry.event.sequence, 0, {
        type: "user/message",
        seq: rc1SessionSeq(0),
        time: createdAt + entry.event.sequence,
        data: rc1Message(entry.event, "user"),
        surfaceOp: "append",
      }, [entry.event.sequence]);
    }

    for (const step of collectPortableSteps(turn)) {
      const nativeStep = step.ordinal + 1;
      const stepFirstSequence = step.events[0]!.event.sequence;
      const stepLastSequence = step.events.at(-1)!.event.sequence;
      push(stepFirstSequence, -300, {
        type: "step/start",
        seq: rc1SessionSeq(0),
        time: createdAt + stepFirstSequence,
        data: { turn: nativeTurn, step: nativeStep },
      });

      const assistantEvents = step.events.filter(({ event }) =>
        event.kind === "reasoning"
        || event.kind === "assistant-message"
        || (event.kind === "tool-call" && matchedToolCallEventIds.has(event.id)));
      // RC1 Chat has one assistant node per turn/step. Combining across a
      // steering message would move later output before that user; emitting
      // two assistant messages in the same step would overwrite its first UI
      // node. Require a planned step boundary instead of silently doing either.
      if (assistantEvents.length > 1 && turn.events.some(({ event }) =>
        event.kind === "user-message"
        && event.sequence > assistantEvents[0]!.event.sequence
        && event.sequence < assistantEvents.at(-1)!.event.sequence)) {
        throw new TypeError(`Canonical step ${step.id} crosses a user steering boundary`);
      }
      const blocks = assistantContentBlocks(assistantEvents, matchedToolCallEventIds);
      if (blocks.length > 0) {
        const assistantSequence = assistantEvents[0]!.event.sequence;
        const assistantId = assistantEvents.length === 1
          && assistantEvents[0]!.event.kind === "assistant-message"
          ? nonEmptyString(canonicalMessageRecord(assistantEvents[0]!.event)?.id)
            ?? assistantEvents[0]!.event.id
          : `mcsf:${turn.id}:${step.id}:assistant`;
        push(assistantSequence, -200, {
          type: "assistant/message",
          seq: rc1SessionSeq(0),
          time: createdAt + assistantSequence,
          data: {
            turn: nativeTurn,
            step: nativeStep,
            message: {
              id: assistantId,
              role: "assistant",
              content: blocks,
              source: assistantSource(assistantEvents),
            },
          },
          surfaceOp: "append",
        }, assistantEvents.map(({ event }) => event.sequence));
      }

      for (const entry of step.events) {
        const { event } = entry;
        if (event.kind === "tool-call") {
          if (!matchedToolCallEventIds.has(event.id)) {
            const callId = strictCallId(event);
            const calls = callId === null ? [] : callsById.get(callId) ?? [];
            const results = callId === null ? [] : resultsById.get(callId) ?? [];
            const reason = callId === null ? "missing-call-id"
              : calls.length !== 1 ? "duplicate-call-id"
                : results.length === 0 ? "unclosed-tool-call"
                  : results.length !== 1 ? "ambiguous-tool-results"
                    : "cross-step-tool-result";
            push(event.sequence, 0, evidenceEvent(
              event,
              "maintenance/unclosed-tool-call",
              reason,
              createdAt,
            ), [event.sequence]);
            continue;
          }
          push(event.sequence, 0, {
            type: "tool/call",
            seq: rc1SessionSeq(0),
            time: createdAt + event.sequence,
            data: canonicalToolCall(event, nativeTurn, nativeStep),
          }, [event.sequence]);
          continue;
        }
        if (event.kind !== "tool-result") continue;
        const callId = strictCallId(event);
        if (callId === null || !matchedToolResultEventIds.has(event.id)) {
          const calls = callId === null ? [] : callsById.get(callId) ?? [];
          const results = callId === null ? [] : resultsById.get(callId) ?? [];
          const reason = callId === null ? "missing-call-id"
            : calls.length === 0 ? "missing-correlated-tool-call"
              : calls.length !== 1 ? "ambiguous-tool-calls"
                : results.length !== 1 ? "ambiguous-tool-results"
                  : "cross-step-tool-call";
          push(event.sequence, 0, evidenceEvent(
            event,
            "maintenance/orphan-tool-result",
            reason,
            createdAt,
          ), [event.sequence]);
          continue;
        }
        push(event.sequence, 0, {
          type: "tool/result",
          seq: rc1SessionSeq(0),
          time: createdAt + event.sequence,
          data: canonicalToolResult(event, nativeTurn, nativeStep),
          surfaceOp: "append",
        }, [event.sequence], callId);
      }

      push(stepLastSequence, 300, {
        type: "step/end",
        seq: rc1SessionSeq(0),
        time: createdAt + stepLastSequence,
        data: { turn: nativeTurn, step: nativeStep },
      });
    }

    push(lastSequence, 400, {
      type: "turn/end",
      seq: rc1SessionSeq(0),
      time: createdAt + lastSequence,
      data: { turn: nativeTurn, reason: { kind: "completed" } },
    });
  }

  drafts.sort((left, right) => left.sourceSequence - right.sourceSequence
    || left.rank - right.rank
    || left.insertionOrder - right.insertionOrder);

  const sequenceMap = new Map<number, number>();
  const callSequenceById = new Map<string, number>();
  for (const [newSequence, draft] of drafts.entries()) {
    for (const origin of draft.originSequences) {
      if (!sequenceMap.has(origin)) sequenceMap.set(origin, newSequence);
    }
    if (draft.event.type !== "tool/call" || !isRecord(draft.event.data)) continue;
    const callId = nonEmptyString(draft.event.data.callId);
    if (callId !== undefined) callSequenceById.set(callId, newSequence);
  }

  return drafts.map((draft, newSequence) => {
    const sourceEventSeqs = draft.event.sourceEventSeqs?.map((sequence) => {
      const rebased = sequenceMap.get(sequence);
      if (rebased === undefined) {
        throw new TypeError(`Rc1 portable projection source sequence ${sequence} has no materialized target`);
      }
      return rc1SessionSeq(rebased);
    });
    const correlatedCallSequence = draft.resultCallId === undefined
      ? undefined
      : callSequenceById.get(draft.resultCallId);
    if (draft.resultCallId !== undefined && correlatedCallSequence === undefined) {
      throw new TypeError(`Rc1 portable projection lost tool call ${draft.resultCallId}`);
    }
    return {
      ...draft.event,
      seq: rc1SessionSeq(newSequence),
      ...(correlatedCallSequence === undefined
        ? sourceEventSeqs === undefined ? {} : { sourceEventSeqs }
        : { sourceEventSeqs: [rc1SessionSeq(correlatedCallSequence)] }),
      ...(draft.event.surfaceOp === undefined
        ? {}
        : { surfaceOp: rebaseSurfaceOp(draft.event.surfaceOp, sequenceMap) }),
    };
  });
}

function materializeEvents(
  events: readonly CanonicalEventV1[],
  createdAt: number,
  anchorAliases = new Map<string, string>(),
): readonly Rc1SessionEvent[] {
  const hasPortableConversation = events.some((event) =>
    isPortableConversationKind(event.kind)
    && rawEnvelope(event) === undefined);
  if (!hasPortableConversation) return materializeNativeEnvelopeEvents(events, createdAt);

  const nativeConversationEventTypes = new Set([
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
  const hasNativeArtifacts = events.some((event) => {
    if (event.kind === "other" || packedStorageEvents(event) !== undefined) return event.kind !== "other";
    const raw = rawEnvelope(event);
    return raw !== undefined && nativeConversationEventTypes.has(raw.type);
  });
  if (hasNativeArtifacts) {
    throw new TypeError(
      "Rc1 projection cannot mix portable conversation topology with native envelopes in one canonical version",
    );
  }
  return materializePortableConversationEvents(events, createdAt, anchorAliases);
}

function canonicalHistoryMode(
  events: readonly CanonicalEventV1[],
): Rc1ProjectionSession["canonicalHistoryMode"] {
  return events.some((event) =>
    isPortableConversationKind(event.kind)
    && rawEnvelope(event) === undefined)
    ? "portable"
    : "native";
}

export function rc1ProjectedNativeRevision(
  canonical: CanonicalProjectionSessionInput,
  payload: JsonValue,
): number {
  if (!isRecord(payload) || !Array.isArray(payload.events)) {
    throw new TypeError(`Rc1 projection ${canonical.session.id} has no native events array`);
  }
  const createdAt = Date.parse(canonical.session.createdAt);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new TypeError(`Canonical session ${canonical.session.id} has an invalid createdAt timestamp`);
  }
  const expected = materializeEvents(canonical.events, createdAt);
  if (payload.events.length < expected.length) {
    throw new TypeError(`Rc1 projection ${canonical.session.id} is shorter than its canonical native prefix`);
  }
  const projectedPrefix = payload.events.slice(0, expected.length);
  if (digest(projectedPrefix) !== digest(expected as unknown as JsonValue)) {
    throw new TypeError(`Rc1 projection ${canonical.session.id} diverges from its canonical native prefix`);
  }
  return expected.length;
}

export function catalogDigest(
  sessionDigests: Readonly<Record<string, string>>,
  workspaceIds: readonly string[],
): string {
  return digest({
    sessions: Object.entries(sessionDigests).sort(([left], [right]) => left.localeCompare(right)),
    workspaces: [...new Set(workspaceIds)].sort(),
  });
}

export function composeRc1ProjectionManifest(
  input: ProjectionManifestCompositionInput,
): ProjectionManifest {
  return {
    schemaVersion: 1,
    runId: input.run.id,
    adapterId: manifest.id,
    sessionCount: Object.keys(input.sessionDigests).length,
    workspaceCount: new Set(input.workspaceIds).size,
    catalogDigest: catalogDigest(input.sessionDigests, input.workspaceIds),
    sessionDigests: input.sessionDigests,
  };
}

export async function materializeRc1(
  input: CanonicalProjectionInput,
  output: ProjectionWriter,
): Promise<ProjectionManifest> {
  for (const workspace of input.workspaces) {
    await output.writeWorkspace(workspace.id, {
      schemaVersion: 1,
      id: workspace.id,
      parentId: workspace.parentId,
      name: workspace.name,
      sortKey: workspace.sortKey,
      deletedAt: workspace.deletedAt,
    });
  }
  const sessionDigests: Record<string, string> = {};
  const workspaceIds = input.workspaces.map((workspace) => workspace.id);
  for (const item of input.sessions) {
    try {
      const nativeSessionId = rc1NativeSessionId(item.session.id);
      const createdAt = Date.parse(item.session.createdAt);
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
        throw new TypeError(`Canonical session ${item.session.id} has an invalid createdAt timestamp`);
      }
      const updatedAt = Date.parse(item.session.updatedAt);
      if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
        throw new TypeError(`Canonical session ${item.session.id} has an invalid updatedAt timestamp`);
      }
      const historyMode = canonicalHistoryMode(item.events);
      const anchorAliases = new Map<string, string>();
      const events = materializeEvents(item.events, createdAt, anchorAliases);
      const payload: Rc1ProjectionSession = {
        schemaVersion: 1,
        logicalSessionId: item.session.id,
        baseVersionId: item.session.headVersionId,
        projectId: item.projectId ?? null,
        projectTitle: item.projectName ?? null,
        workspaceId: item.workspaceId,
        updatedAt: item.session.updatedAt,
        title: item.session.title,
        tags: item.session.tags,
        canonicalHistoryMode: historyMode,
        ...(historyMode === "portable" ? { anchorAliases: Object.fromEntries(anchorAliases) } : {}),
        inheritedEventCount: rc1SessionLogOffset(0),
        header: {
          version: 0,
          id: nativeSessionId,
          createdAt,
          delegationDepth: 0,
          isSeeded: false,
          ...(item.projectRoot === null ? {} : { cwd: item.projectRoot }),
        },
        events,
      };
      await output.writeSession(nativeSessionId, payload as unknown as JsonValue);
      sessionDigests[nativeSessionId] = digest(payload as unknown as JsonValue);
    } catch (error) {
      throw new TypeError(
        `Rc1 projection session ${item.session.id} failed: ${diagnosticMessage(error)}`,
        { cause: error },
      );
    }
  }
  return composeRc1ProjectionManifest({ run: input.run, sessionDigests, workspaceIds });
}
