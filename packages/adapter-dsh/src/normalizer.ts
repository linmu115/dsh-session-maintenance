import type {
  CompatibilityIssue,
  JsonValue,
  NormalizedSession,
  StableObservation,
} from "@linmu/dsh-session-contracts";
import { normalizeSession, sha256Canonical, type RawSessionEvent } from "@linmu/dsh-session-domain";

import { isDshObservationPayload } from "./reader.js";
import { dshEventSequence, dshEventTime, type DshSessionEvent } from "./zstd-codec.js";

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function eventId(event: DshSessionEvent): string {
  const sequence = dshEventSequence(event);
  if ("seq0" in event) return `seq-${sequence}-${event.type}`;
  const candidate = event.data.id;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : `seq-${sequence}-${event.type}`;
}

function contentText(event: DshSessionEvent): string {
  const content = event.data.content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      typeof part === "object" &&
      part !== null &&
      !Array.isArray(part) &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

function toolImport(call: DshSessionEvent, result: DshSessionEvent | undefined, sequence: number): RawSessionEvent {
  const name = typeof call.data.name === "string" ? call.data.name : "unknown-tool";
  return {
    sourceEventId: result === undefined ? eventId(call) : `${eventId(call)}+${eventId(result)}`,
    parentSourceEventId: null,
    sequence,
    kind: "tool-import",
    role: "tool",
    content: `[DSH imported tool record: ${name}]`,
    attachments: [],
    extensions: {
      importedFrom: "DSH",
      sourceTypes: result === undefined ? [call.type] : [call.type, result.type],
      call: asJson(call.data),
      ...(result === undefined ? {} : { result: asJson(result.data) }),
    },
  };
}

export function normalizeDshObservation(observation: StableObservation): NormalizedSession {
  if (!isDshObservationPayload(observation.payload)) {
    throw new TypeError("Stable observation is not a supported DSH payload");
  }
  const payload = observation.payload;
  const events: RawSessionEvent[] = [];
  const issues: CompatibilityIssue[] = [];

  for (let index = 0; index < payload.events.length; index += 1) {
    const event = payload.events[index];
    if (event === undefined) continue;
    if (event.type === "user/message" || event.type === "assistant/message") {
      events.push({
        sourceEventId: eventId(event),
        parentSourceEventId: null,
        sequence: events.length,
        kind: "message",
        role: event.type === "user/message" ? "user" : "assistant",
        content: contentText(event),
        attachments: [],
        extensions: { sourceType: event.type },
      });
      continue;
    }
    if (event.type === "tool/call") {
      const next = payload.events[index + 1];
      const result = next?.type === "tool/result" ? next : undefined;
      events.push(toolImport(event, result, events.length));
      if (result !== undefined) index += 1;
      continue;
    }
    if (event.type === "tool/result") {
      events.push(toolImport(event, undefined, events.length));
      continue;
    }

    events.push({
      sourceEventId: eventId(event),
      parentSourceEventId: null,
      sequence: events.length,
      kind: "metadata",
      role: "unknown",
      content: "",
      attachments: [],
      extensions: { dshEvent: asJson(event), sourceType: event.type },
    });
    issues.push({
      code: "DSH_EVENT_DEGRADED",
      message: `Unsupported DSH event preserved as source metadata: ${event.type}`,
      sourceType: event.type,
    });
  }

  const latestTime = Math.max(payload.header.createdAt, ...payload.events.map(dshEventTime));
  const observedAt = new Date(latestTime < 1_000_000_000_000 ? latestTime * 1000 : latestTime).toISOString();
  return normalizeSession({
    key: observation.key,
    title: payload.title,
    archived: payload.archived,
    // Keep platform workspace identity separate from the cross-platform directory index.
    // Directory grouping is recorded from the catalog summary and must not change
    // discovery confidence or normalized session hashes.
    workspaceId: `workspace_${sha256Canonical({
      instanceId: observation.key.instanceId,
      projectId: payload.projectId,
    }).slice(0, 24)}`,
    provenance: { ...observation.key, observedAt, sourceVersion: "0.1.1-rc.2" },
    compatibility: { status: issues.length === 0 ? "compatible" : "degraded", issues },
    events,
  });
}
