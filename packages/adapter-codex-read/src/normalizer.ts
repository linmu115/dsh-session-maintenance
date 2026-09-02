import type {
  AttachmentRef,
  CompatibilityIssue,
  JsonValue,
  NormalizedSession,
  StableObservation,
} from "@linmu/dsh-session-contracts";
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
  lineIndex: number,
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

  const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
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
    sourceEventId: stringValue(payload.id) ?? `${sourceType}-${lineIndex}`,
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

function visibleUserText(value: string): string {
  let visible = value
    .replace(/<codex_internal_context\b[^>]*>[\s\S]*?<\/codex_internal_context>/giu, "")
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/giu, "")
    .replace(/<environment_context\b[^>]*>[\s\S]*?<\/environment_context>/giu, "")
    .replace(/(?:^|\n)# Response annotations:[\s\S]*?<\/response-annotations>\s*/giu, "\n");
  visible = visible.replace(
    /<codex_delegation\b[^>]*>[\s\S]*?<input>([\s\S]*?)<\/input>[\s\S]*?<\/codex_delegation>/giu,
    "$1",
  );
  return visible.trim();
}

function messageEvent(
  envelope: CodexEnvelope,
  lineIndex: number,
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
  const importedContent = importedMode === "visible-record" || importedMode === "metadata-record"
    ? joinedContent.replace(/^\[DSH 导入记录 · [^\]]+\]\n/u, "")
    : payload.role === "user"
      ? visibleUserText(joinedContent)
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
      typeof payload.id === "string" && payload.id.length > 0 ? payload.id : `line-${lineIndex}`,
    parentSourceEventId: null,
    sequence,
    kind: importedMode === "visible-record" ? "tool-import" : importedMode === "metadata-record" ? "metadata" : "message",
    role,
    content: importedContent,
    attachments,
    extensions: {
      ...(unknownContent.length === 0 ? {} : { unknownContent }),
      ...(imported === undefined ? {} : { dshImport: imported as JsonValue }),
    },
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
      if (message === null) continue;
      if (message !== undefined) {
        events.push(message);
        continue;
      }
      const tool = toolEvent(envelope, lineIndex, events.length);
      if (tool !== undefined) {
        events.push(tool);
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
}
