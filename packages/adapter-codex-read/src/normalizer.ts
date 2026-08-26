import type {
  AttachmentRef,
  CompatibilityIssue,
  JsonValue,
  NormalizedSession,
  StableObservation,
} from "@linmu/dsh-session-contracts";
import {
  normalizeSession,
  sha256Canonical,
  type RawSessionEvent,
} from "@linmu/dsh-session-domain";

import {
  isCodexObservationPayload,
  type CodexEnvelope,
} from "./parser.js";

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function messageEvent(
  envelope: CodexEnvelope,
  lineIndex: number,
  sequence: number,
): RawSessionEvent | undefined {
  const payload = envelope.payload;
  if (payload.type !== "message" || typeof payload.role !== "string" || !Array.isArray(payload.content)) {
    return undefined;
  }
  const role = ["user", "assistant", "system"].includes(payload.role)
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

  return {
    sourceEventId:
      typeof payload.id === "string" && payload.id.length > 0 ? payload.id : `line-${lineIndex}`,
    parentSourceEventId: null,
    sequence,
    kind: "message",
    role,
    content: text.join("\n"),
    attachments,
    extensions: unknownContent.length === 0 ? {} : { unknownContent },
  };
}

export function normalizeCodexObservation(observation: StableObservation): NormalizedSession {
  if (!isCodexObservationPayload(observation.payload)) {
    throw new TypeError("Stable observation is not a supported Codex payload");
  }
  const payload = observation.payload;
  const events: RawSessionEvent[] = [];
  const issues: CompatibilityIssue[] = [];
  for (const [lineIndex, envelope] of payload.envelopes.entries()) {
    if (envelope.type === "session_meta") {
      continue;
    }
    if (envelope.type === "response_item") {
      const message = messageEvent(envelope, lineIndex, events.length);
      if (message !== undefined) {
        events.push(message);
        continue;
      }
    }

    events.push({
      sourceEventId: `line-${lineIndex}`,
      parentSourceEventId: null,
      sequence: events.length,
      kind: "metadata",
      role: "unknown",
      content: "",
      attachments: [],
      extensions: { codexEnvelope: asJson(envelope) },
    });
    issues.push({
      code: "CODEX_EVENT_DEGRADED",
      message: `Unsupported Codex envelope preserved as source metadata: ${envelope.type}`,
      sourceType: envelope.type,
    });
  }

  return normalizeSession({
    key: observation.key,
    title: payload.thread.title || payload.thread.name,
    archived: Boolean(payload.thread.archived),
    workspaceId: `workspace_${sha256Canonical(payload.thread.cwd).slice(0, 24)}`,
    provenance: {
      ...observation.key,
      observedAt: payload.thread.updated_at,
      sourceVersion: "0.146.0",
    },
    compatibility: { status: issues.length === 0 ? "compatible" : "degraded", issues },
    events,
  });
}
