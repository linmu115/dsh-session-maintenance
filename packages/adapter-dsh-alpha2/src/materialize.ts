import { createHash } from "node:crypto";

import type {
  CanonicalEventV1,
  CanonicalProjectionInput,
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
  readonly workspaceId: string | null;
  readonly title: string;
  readonly tags: readonly string[];
  readonly header: {
    readonly version: 0;
    readonly id: NativeSessionId;
    readonly createdAt: number;
    readonly cwd?: string;
  };
  readonly events: readonly Alpha2SessionEvent[];
}

export function alpha2NativeSessionId(logicalSessionId: LogicalSessionId): NativeSessionId {
  return `dsh-maintenance:${logicalSessionId}` as NativeSessionId;
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

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
    ...(Array.isArray(raw.sourceEventSeqs) ? { sourceEventSeqs: raw.sourceEventSeqs as number[] } : {}),
    ...(raw.surfaceOp !== undefined ? { surfaceOp: raw.surfaceOp } : {}),
  };
  return output;
}

function messageContent(event: CanonicalEventV1): { readonly [key: string]: JsonValue } {
  if (isRecord(event.content)) return event.content;
  return {
    role: event.role,
    content: [{ type: "text", text: String(event.content) }],
  };
}

export function materializeEvent(event: CanonicalEventV1, createdAt: number): Alpha2SessionEvent {
  const raw = rawEnvelope(event);
  if (raw !== undefined) return raw;
  const time = createdAt + event.sequence;
  if (event.kind === "user-message") {
    return { type: "user/message", seq: event.sequence, time, data: messageContent(event), surfaceOp: "append" };
  }
  if (event.kind === "assistant-message") {
    const content = messageContent(event);
    const data = "message" in content ? content : { turn: 0, step: 0, message: content };
    return { type: "assistant/message", seq: event.sequence, time, data, surfaceOp: "append" };
  }
  if (event.kind === "tool-call") {
    return { type: "tool/call", seq: event.sequence, time, data: event.content };
  }
  if (event.kind === "tool-result") {
    return { type: "tool/result", seq: event.sequence, time, data: event.content, surfaceOp: "append" };
  }
  return {
    type: `maintenance/${event.kind}`,
    seq: event.sequence,
    time,
    data: { canonicalContent: event.content, extensions: event.extensions },
    ignorable: true,
  };
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
    const payload: Alpha2ProjectionSession = {
      schemaVersion: 1,
      logicalSessionId: item.session.id,
      baseVersionId: item.session.headVersionId,
      projectId: item.projectId ?? null,
      workspaceId: item.workspaceId,
      title: item.session.title,
      tags: item.session.tags,
      header: {
        version: 0,
        id: nativeSessionId,
        createdAt,
        ...(item.projectRoot === null ? {} : { cwd: item.projectRoot }),
      },
      events: item.events.map((event) => materializeEvent(event, createdAt)),
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
