import { createHash } from "node:crypto";
import {
  readCanonicalConversationTopologyV1, type CanonicalEventV1, type JsonValue,
  type UserRequestAssociationState, type UserRequestAttachmentRef, type UserRequestExecutionRef,
  type UserRequestRelation, type UserRequestReplyRef, type UserRequestState,
} from "@linmu/dsh-session-contracts";
import { readDshReaderPresentation } from "./reader-presentation.js";

const record = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, JsonValue>> : {};
const identity = (value: JsonValue | undefined): string | null => typeof value === "string"
  && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const dshUserRequestId = (event: Pick<CanonicalEventV1, "logicalSessionId" | "id">): string =>
  `request-${digest([event.logicalSessionId, event.id])}`;

interface Execution {
  id: string; turnId: string; boundaryEventId: string | null; start: number; end: number;
  endEventId: string | null; state: UserRequestState; requests: string[];
  replies: Array<UserRequestReplyRef & { index: number; step: number | null; turn: number | null }>;
  completedSteps: Set<string>;
}

/** Bounded structural metadata, never stores a second copy of message bodies. */
export interface DshUserRequestIndexEntry {
  requestId: string; eventId: string; nativeMessageId: string | null; ordinal: number; createdAt: string | null;
  sourceTrust: "verified" | "unverified";
  attachmentRefs: UserRequestAttachmentRef[]; attachmentsOmitted: number;
  executionRefs: UserRequestExecutionRef[]; replyRefs: UserRequestReplyRef[]; replyRefsOmitted: number;
  turnId: string | null; turnBoundaryEventId: string | null; relation: UserRequestRelation;
  state: UserRequestState; associationState: UserRequestAssociationState;
  startEventId: string; endEventId: string; replyEventId: string | null;
  rangeState: "complete" | "partial" | "request-only";
}

function *textParts(event: CanonicalEventV1): Generator<string> {
  const c = record(event.content);
  if (typeof event.content === "string") { yield event.content; return; }
  if (typeof c.text === "string") { yield c.text; return; }
  const message = c.message === undefined ? c : record(c.message);
  const blocks = message.content;
  if (typeof blocks === "string") { yield blocks; return; }
  if (!Array.isArray(blocks)) return;
  let emitted = false;
  for (const value of blocks) {
    const block = record(value);
    if (!["text", "input_text", "output_text"].includes(String(block.type)) || typeof block.text !== "string") continue;
    if (emitted) yield "\n\n";
    yield block.text; emitted = true;
  }
}

/** Unicode code-point offsets, bounded output; never serializes attachment data. */
export function readDshUserRequestText(event: CanonicalEventV1, offset = 0, limit = 384): { text: string; totalChars: number; nextOffset: number | null } {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0 || limit > 16000)
    throw new TypeError("请求原文读取范围无效");
  let totalChars = 0, text = "", returned = 0;
  for (const part of textParts(event)) for (const character of part) {
    if (totalChars >= offset && returned < limit) { text += character; returned++; }
    totalChars++;
  }
  if (offset > totalChars) throw new TypeError("请求原文读取位置超出末尾");
  return { text, totalChars, nextOffset: offset + returned < totalChars ? offset + returned : null };
}

function attachments(event: CanonicalEventV1): { attachmentRefs: UserRequestAttachmentRef[]; attachmentsOmitted: number } {
  const c = record(event.content), message = c.message === undefined ? c : record(c.message);
  const blocks = Array.isArray(message.content) ? message.content : [];
  const refs: UserRequestAttachmentRef[] = []; let total = 0;
  for (const [index, value] of blocks.entries()) {
    const block = record(value);
    if (!["image", "input_image", "file", "input_file", "audio", "input_audio", "video"].includes(String(block.type))) continue;
    total++;
    if (refs.length === 8) continue;
    refs.push({ id: identity(block.id) ?? `attachment-${digest([event.id, index])}`, type: String(block.type),
      name: typeof block.name === "string" ? [...block.name].slice(0, 120).join("") : null,
      mimeType: identity(block.mimeType) ?? identity(block.mediaType) });
  }
  return { attachmentRefs: refs, attachmentsOmitted: total - refs.length };
}

function submittedUserTrust(event: CanonicalEventV1): "verified" | "unverified" {
  const c = record(event.content), source = record(c.source);
  // Plugin helpers such as admit-images persist real requests with kind:user.
  // A plugin's generic user-role context does not acquire user authority.
  return event.source.platform === "dsh" && event.extensions.dshEventType === "user/message"
    && c.role === "user" && source.kind === "user" && identity(c.id) !== null ? "verified" : "unverified";
}

function endState(value: JsonValue | undefined): UserRequestState {
  const kind = record(value).kind;
  if (kind === "completed") return "completed";
  if (kind === "failed" || kind === "error") return "failed";
  if (kind === "cancelled" || kind === "canceled" || kind === "interrupted") return "cancelled";
  return "unknown";
}

/**
 * Call only with the already authorized immutable prefix. Display-turn grouping
 * is deliberately not used. Native turn/start or MCSF topology owns association.
 */
export function buildDshUserRequestIndex(events: readonly CanonicalEventV1[], options: { completedCutoffEventId?: string } = {}): DshUserRequestIndexEntry[] {
  const executions = new Map<string, Execution>();
  const requests: Array<{ event: CanonicalEventV1; index: number; trust: "verified" | "unverified"; execution?: Execution }> = [];
  let active: Execution | undefined;
  const pending: typeof requests = [];
  for (const [index, event] of events.entries()) {
    const c = record(event.content), raw = record(event.rawPayload);
    const nativeType = event.source.platform === "dsh" ? event.extensions.dshEventType : undefined;
    const topology = readCanonicalConversationTopologyV1(event);
    if (nativeType === "turn/start" && Number.isSafeInteger(c.turn)) {
      const key = `native:${event.id}`;
      active = { id: `execution-${digest([event.logicalSessionId, event.id])}`, turnId: key, boundaryEventId: event.id,
        start: index, end: index, endEventId: null, state: "running", requests: [], replies: [], completedSteps: new Set() };
      executions.set(key, active);
      // Requests durably queued before this native start belong to the same
      // execution; multiple supplements remain separate request identities.
      for (const queued of pending.splice(0)) { queued.execution = active; active.requests.push(queued.event.id); active.start = Math.min(active.start, queued.index); }
    }
    let execution = active;
    if (topology) {
      execution = executions.get(topology.turnId);
      if (!execution) {
        execution = active ?? { id: `execution-${digest([event.logicalSessionId, topology.turnId])}`, turnId: topology.turnId,
          boundaryEventId: null, start: index, end: index, endEventId: null, state: "unknown", requests: [], replies: [], completedSteps: new Set() };
        executions.set(topology.turnId, execution);
      }
      execution.turnId = topology.turnId;
    }
    if (execution) execution.end = index;
    if (nativeType === "step/end" && execution) execution.completedSteps.add(`${String(c.turn)}:${String(c.step)}`);
    if (nativeType === "turn/end" && active) {
      active.state = endState(c.reason); active.endEventId = event.id; active = undefined;
    }
    if (raw.surfaceOp !== undefined && raw.surfaceOp !== "append") continue;
    const presentation = readDshReaderPresentation(event);
    if (presentation.kind === "user" && event.kind === "user-message" && event.role === "user") {
      const request = { event, index, trust: submittedUserTrust(event), ...(execution ? { execution } : {}) };
      requests.push(request);
      if (execution) execution.requests.push(event.id); else pending.push(request);
    }
    if (presentation.kind === "assistant" && execution) {
      const message = c.message === undefined ? c : record(c.message);
      // Metadata is sufficient here: never read assistant or tool body text.
      execution.replies.push({ eventId: event.id, nativeMessageId: identity(message.id), index,
        turn: typeof c.turn === "number" ? c.turn : null, step: typeof c.step === "number" ? c.step : null,
        completed: event.id === options.completedCutoffEventId });
    }
  }
  return requests.map(({ event, index, trust, execution }, ordinal) => {
    const raw = record(event.rawPayload), nativeId = identity(record(event.content).id);
    const replies = (execution?.replies ?? []).filter(reply => reply.index >= index).map(reply => ({ ...reply, completed: reply.completed
      || (reply.turn !== null && reply.step !== null && execution!.completedSteps.has(`${reply.turn}:${reply.step}`)) }));
    const final = replies.findLast(reply => reply.completed), end = final?.index ?? execution?.end ?? index;
    const createdAt = typeof raw.time === "number" && Number.isFinite(raw.time) && Math.abs(raw.time) <= 8.64e15
      ? new Date(raw.time).toISOString() : null;
    return {
      requestId: dshUserRequestId(event), eventId: event.id, nativeMessageId: nativeId, ordinal: ordinal + 1, createdAt,
      sourceTrust: trust, ...(trust === "verified" ? attachments(event) : { attachmentRefs: [], attachmentsOmitted: 0 }),
      executionRefs: execution ? [{ id: execution.id, boundaryEventId: execution.boundaryEventId, endEventId: execution.endEventId, state: execution.state }] : [],
      replyRefs: replies.slice(-8).map(({ eventId, nativeMessageId, completed }) => ({ eventId, nativeMessageId, completed })),
      replyRefsOmitted: Math.max(0, replies.length - 8), turnId: execution?.turnId ?? null, turnBoundaryEventId: execution?.boundaryEventId ?? null,
      relation: execution ? execution.requests[0] === event.id ? "initial" as const : "supplement" as const : "unknown" as const,
      state: trust === "unverified" ? "unknown" as const : execution?.state ?? "pending" as const,
      associationState: trust === "unverified" || !execution ? "unknown" as const : execution.boundaryEventId && final ? "verified" as const : "partial" as const,
      startEventId: events[Math.min(execution?.start ?? index, index)]!.id, endEventId: events[Math.max(index, end)]!.id,
      replyEventId: final?.eventId ?? null, rangeState: !execution ? "request-only" as const : final ? "complete" as const : "partial" as const,
    };
  });
}
