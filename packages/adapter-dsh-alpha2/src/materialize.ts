import { createHash } from "node:crypto";

import type {
  CanonicalEventV1,
  CanonicalProjectionInput,
  CanonicalProjectionSessionInput,
  JsonValue,
  LogicalSessionId,
  NativeSessionId,
  ProjectionManifest,
  ProjectionWriter,
} from "@linmu/dsh-session-adapter-sdk";

import { manifest } from "./manifest.js";

export interface Alpha2SessionEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: JsonValue;
  readonly ignorable?: true;
  readonly sourceEventSeqs?: readonly number[];
  readonly surfaceOp?: JsonValue;
}

export interface Alpha2ProjectionSession {
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
  readonly header: {
    readonly version: 0;
    readonly id: NativeSessionId;
    readonly createdAt: number;
    readonly delegationDepth: 0;
    readonly cwd?: string;
  };
  readonly events: readonly Alpha2SessionEvent[];
}

export function alpha2NativeSessionId(logicalSessionId: LogicalSessionId): NativeSessionId {
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

function decodeSourceEventSeqs(value: JsonValue, eventSeq: number): readonly number[] {
  if (!Array.isArray(value)) throw new TypeError("Alpha2 sourceEventSeqs must be an array");
  const decoded: number[] = [];
  let hasRange = false;
  for (const entry of value) {
    if (typeof entry === "number") {
      if (!Number.isSafeInteger(entry) || entry < 0 || decoded.length >= eventSeq) {
        throw new TypeError("Alpha2 sourceEventSeqs contains an invalid sequence");
      }
      decoded.push(entry);
      continue;
    }
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError("Alpha2 sourceEventSeqs range must be [start, end]");
    }
    const [start, end] = entry;
    if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end) || start < 0 || end < start || end - start + 1 > eventSeq - decoded.length) {
      throw new TypeError("Alpha2 sourceEventSeqs contains an invalid range");
    }
    for (let sequence = start; sequence <= end; sequence += 1) decoded.push(sequence);
    hasRange = true;
  }
  if (hasRange && decoded.some((sequence, index) => index > 0 && sequence <= decoded[index - 1]!)) {
    throw new TypeError("Alpha2 sourceEventSeqs ranges must be strictly increasing");
  }
  return decoded;
}

function packedStorageEvents(event: CanonicalEventV1): readonly Alpha2SessionEvent[] | undefined {
  if (!isRecord(event.rawPayload)) return undefined;
  const raw = event.rawPayload;
  const tag = raw.type;
  if (tag !== "text-chunks" && tag !== "reasoning-chunks" && tag !== "tool-call-chunks") return undefined;
  if (typeof raw.time !== "number" || !Number.isSafeInteger(raw.time) || !isRecord(raw.data)) {
    throw new TypeError(`Malformed Alpha2 ${tag} canonical storage row`);
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
    throw new TypeError(`Malformed Alpha2 ${tag} canonical storage row`);
  }
  if (payload.length - 1 > Number.MAX_SAFE_INTEGER - event.sequence) {
    throw new TypeError(`Alpha2 ${tag} canonical storage row exceeds safe event sequences`);
  }
  const output: Alpha2SessionEvent[] = [];
  let time = Number(raw.time);
  for (let index = 0; index < payload.length; index += 1) {
    if (index > 0) time += Number(data.dt[index - 1]!);
    if (!Number.isSafeInteger(time)) throw new TypeError(`Alpha2 ${tag} canonical storage row has an invalid time`);
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
      seq: event.sequence + index,
      time,
      data: { turn: data.turn, step: data.step, chunk },
    });
  }
  return output;
}

function rawEnvelope(event: CanonicalEventV1): Alpha2SessionEvent | undefined {
  if (!isRecord(event.rawPayload)) return undefined;
  const raw = event.rawPayload;
  if (typeof raw.type !== "string" || !Number.isSafeInteger(raw.seq) || !Number.isSafeInteger(raw.time) || !("data" in raw)) {
    return undefined;
  }
  const output: Alpha2SessionEvent = {
    type: raw.type,
    seq: event.sequence,
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

  // Alpha2 requires an array but accepts an empty textual message. Keeping one
  // block also gives imported metadata-only turns a stable surface node.
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

function alpha2Message(
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

function canonicalToolCall(event: CanonicalEventV1): { readonly [key: string]: JsonValue } {
  const content = canonicalToolRecord(event);
  return {
    turn: 0,
    step: 0,
    callId: nonEmptyString(content.callId) ?? event.id,
    name: nonEmptyString(content.name) ?? "codex-tool",
    arguments: typeof content.arguments === "string" ? content.arguments : "",
  };
}

function canonicalToolResult(event: CanonicalEventV1): { readonly [key: string]: JsonValue } {
  const content = canonicalToolRecord(event);
  const callId = nonEmptyString(content.callId) ?? event.id;
  const text = typeof content.outputText === "string" ? content.outputText : "";
  const isError = content.isError === true;
  return {
    turn: 0,
    step: 0,
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

export function materializeEvent(event: CanonicalEventV1, createdAt: number): Alpha2SessionEvent {
  const raw = rawEnvelope(event);
  if (raw !== undefined) return raw;
  const time = createdAt + event.sequence;
  if (event.kind === "user-message") {
    return {
      type: "user/message",
      seq: event.sequence,
      time,
      data: alpha2Message(event, "user"),
      surfaceOp: "append",
    };
  }
  if (event.kind === "assistant-message") {
    const envelope = isRecord(event.content) && isRecord(event.content.message) ? event.content : undefined;
    return {
      type: "assistant/message",
      seq: event.sequence,
      time,
      data: {
        turn: typeof envelope?.turn === "number" ? envelope.turn : 0,
        step: typeof envelope?.step === "number" ? envelope.step : 0,
        message: alpha2Message(event, "assistant"),
      },
      surfaceOp: "append",
    };
  }
  if (event.kind === "tool-call") {
    return {
      type: "tool/call",
      seq: event.sequence,
      time,
      data: canonicalToolCall(event),
    };
  }
  if (event.kind === "tool-result") {
    return {
      type: "tool/result",
      seq: event.sequence,
      time,
      data: canonicalToolResult(event),
      surfaceOp: "append",
    };
  }
  return {
    type: `maintenance/${event.kind}`,
    seq: event.sequence,
    time,
    data: { canonicalContent: event.content, extensions: event.extensions },
    ignorable: true,
  };
}

function materializeEvents(events: readonly CanonicalEventV1[], createdAt: number): readonly Alpha2SessionEvent[] {
  const output = events.flatMap((event) => packedStorageEvents(event) ?? [materializeEvent(event, createdAt)]);
  for (const [index, event] of output.entries()) {
    if (event.seq !== index) {
      throw new TypeError(`Alpha2 projection event sequence is not contiguous: expected ${index}, got ${event.seq}`);
    }
  }
  return output;
}

export function alpha2ProjectedNativeRevision(
  canonical: CanonicalProjectionSessionInput,
  payload: JsonValue,
): number {
  if (!isRecord(payload) || !Array.isArray(payload.events)) {
    throw new TypeError(`Alpha2 projection ${canonical.session.id} has no native events array`);
  }
  const createdAt = Date.parse(canonical.session.createdAt);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new TypeError(`Canonical session ${canonical.session.id} has an invalid createdAt timestamp`);
  }
  const expected = materializeEvents(canonical.events, createdAt);
  if (payload.events.length < expected.length) {
    throw new TypeError(`Alpha2 projection ${canonical.session.id} is shorter than its canonical native prefix`);
  }
  const projectedPrefix = payload.events.slice(0, expected.length);
  if (digest(projectedPrefix) !== digest(expected as unknown as JsonValue)) {
    throw new TypeError(`Alpha2 projection ${canonical.session.id} diverges from its canonical native prefix`);
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

export async function materializeAlpha2(
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
    const nativeSessionId = alpha2NativeSessionId(item.session.id);
    const createdAt = Date.parse(item.session.createdAt);
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw new TypeError(`Canonical session ${item.session.id} has an invalid createdAt timestamp`);
    }
    const updatedAt = Date.parse(item.session.updatedAt);
    if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
      throw new TypeError(`Canonical session ${item.session.id} has an invalid updatedAt timestamp`);
    }
    const payload: Alpha2ProjectionSession = {
      schemaVersion: 1,
      logicalSessionId: item.session.id,
      baseVersionId: item.session.headVersionId,
      projectId: item.projectId ?? null,
      projectTitle: item.projectName ?? null,
      workspaceId: item.workspaceId,
      updatedAt: item.session.updatedAt,
      title: item.session.title,
      tags: item.session.tags,
      header: {
        version: 0,
        id: nativeSessionId,
        createdAt,
        delegationDepth: 0,
        ...(item.projectRoot === null ? {} : { cwd: item.projectRoot }),
      },
      events: materializeEvents(item.events, createdAt),
    };
    await output.writeSession(nativeSessionId, payload as unknown as JsonValue);
    sessionDigests[nativeSessionId] = digest(payload as unknown as JsonValue);
  }
  return {
    schemaVersion: 1,
    runId: input.run.id,
    adapterId: manifest.id,
    sessionCount: input.sessions.length,
    workspaceCount: input.workspaces.length,
    catalogDigest: catalogDigest(sessionDigests, workspaceIds),
    sessionDigests,
  };
}
