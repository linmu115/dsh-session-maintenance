import { createHash } from "node:crypto";

import type { CanonicalEventV1, CanonicalProjectionInput, JsonValue, LogicalSessionId, NativeSessionId, ProjectionManifest, ProjectionWriter } from "@linmu/dsh-session-adapter-sdk";

import { manifest } from "./manifest.js";

export interface Rc2SessionEvent { readonly type: string; readonly seq: number; readonly time: number; readonly data: JsonValue; readonly [key: string]: JsonValue }
export interface Rc2ProjectionSession {
  readonly logicalSessionId: LogicalSessionId;
  readonly baseVersionId: string | null;
  readonly projectId: string | null;
  readonly title: string;
  readonly tags: readonly string[];
  readonly archived: boolean;
  readonly header: { readonly type: "session"; readonly version: 0; readonly id: NativeSessionId; readonly createdAt: number; readonly cwd: string; readonly delegationDepth: 0 };
  readonly events: readonly Rc2SessionEvent[];
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalize(child)]));
  return value;
}
export function rc2Digest(value: JsonValue): string { return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex")}`; }
export function rc2NativeSessionId(logicalSessionId: LogicalSessionId): NativeSessionId { return `dsh-maintenance-rc2:${logicalSessionId}` as NativeSessionId; }
function record(value: JsonValue): value is { readonly [key: string]: JsonValue } { return value !== null && typeof value === "object" && !Array.isArray(value); }
function messageContent(event: CanonicalEventV1): JsonValue { return record(event.content) ? event.content : { content: [{ type: "text", text: String(event.content) }] }; }

export function materializeRc2Event(event: CanonicalEventV1, createdAt: number): Rc2SessionEvent {
  if (record(event.rawPayload) && typeof event.rawPayload.type === "string" && Number.isSafeInteger(event.rawPayload.time) && "data" in event.rawPayload) {
    return { ...event.rawPayload, type: event.rawPayload.type, seq: event.sequence, time: event.rawPayload.time as number, data: event.rawPayload.data as JsonValue } as Rc2SessionEvent;
  }
  const time = createdAt + event.sequence;
  if (event.kind === "user-message") return { type: "user/message", seq: event.sequence, time, data: messageContent(event) };
  if (event.kind === "assistant-message") return { type: "assistant/message", seq: event.sequence, time, data: messageContent(event) };
  if (event.kind === "tool-call") return { type: "tool/call", seq: event.sequence, time, data: event.content };
  if (event.kind === "tool-result") return { type: "tool/result", seq: event.sequence, time, data: event.content };
  return { type: `maintenance/${event.kind}`, seq: event.sequence, time, data: { canonicalContent: event.content, extensions: event.extensions }, ignorable: true };
}

function catalogDigest(sessionDigests: Readonly<Record<string, string>>, workspaceIds: readonly string[]): string {
  return rc2Digest({ sessions: Object.entries(sessionDigests).sort(([left], [right]) => left.localeCompare(right)), workspaces: [...new Set(workspaceIds)].sort() });
}

export async function materializeRc2(input: CanonicalProjectionInput, output: ProjectionWriter): Promise<ProjectionManifest> {
  for (const workspace of input.workspaces) await output.writeWorkspace(workspace.id, { id: workspace.id, parentId: workspace.parentId, name: workspace.name, sortKey: workspace.sortKey, deletedAt: workspace.deletedAt });
  const sessionDigests: Record<string, string> = {};
  for (const item of input.sessions) {
    const createdAt = Date.parse(item.session.createdAt);
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError(`Canonical session ${item.session.id} has an invalid createdAt timestamp`);
    const nativeId = rc2NativeSessionId(item.session.id);
    const payload: Rc2ProjectionSession = {
      logicalSessionId: item.session.id,
      baseVersionId: item.session.headVersionId,
      projectId: item.workspaceId,
      title: item.session.title,
      tags: item.session.tags,
      archived: item.session.archivedAt !== null,
      header: { type: "session", version: 0, id: nativeId, createdAt, cwd: `maintenance://${item.workspaceId ?? "unclassified"}`, delegationDepth: 0 },
      events: item.events.map((event) => materializeRc2Event(event, createdAt)),
    };
    await output.writeSession(nativeId, payload as unknown as JsonValue);
    sessionDigests[nativeId] = rc2Digest(payload as unknown as JsonValue);
  }
  return { schemaVersion: 1, runId: input.run.id, adapterId: manifest.id, sessionCount: input.sessions.length, workspaceCount: input.workspaces.length, catalogDigest: catalogDigest(sessionDigests, input.workspaces.map((workspace) => workspace.id)), sessionDigests };
}

export { catalogDigest as rc2CatalogDigest };
