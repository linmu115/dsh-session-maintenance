import type { JsonValue, NormalizedEvent } from "@linmu/dsh-session-contracts";

export interface CodexNativeEnvelope {
  readonly timestamp: string;
  readonly type: "response_item";
  readonly payload: Readonly<Record<string, JsonValue>>;
}

function provenance(event: NormalizedEvent): JsonValue {
  return {
    platform: "dsh",
    instanceId: event.source.instanceId,
    sessionId: event.source.sessionId,
    sequence: event.source.sequence,
    ...(event.source.eventId === undefined ? {} : { eventId: event.source.eventId }),
    normalizedEventId: event.id,
  };
}

function attachmentText(event: NormalizedEvent): string {
  return event.attachments.length === 0
    ? ""
    : `\n\n附件：\n${event.attachments.map((item) => `- ${item.name}: ${item.source}`).join("\n")}`;
}

export function mapDshEventsToCodex(
  events: readonly NormalizedEvent[],
  startedAt: string,
): readonly CodexNativeEnvelope[] {
  const start = Date.parse(startedAt);
  return events.map((event, index) => {
    const ordinary = event.kind === "message" && ["user", "assistant", "system"].includes(event.role);
    const role = ordinary ? event.role : "user";
    const text = ordinary
      ? `${event.content}${attachmentText(event)}`
      : `[DSH 导入记录 · ${event.kind}]\n${event.content || "该事件无法等价转换为 Codex 原生消息。"}${attachmentText(event)}`;
    return {
      timestamp: new Date(start + index).toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        role,
        content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
        dsh_import: {
          mode: ordinary ? "native-message" : event.kind === "metadata" ? "metadata-record" : "visible-record",
          provenance: provenance(event),
        },
      },
    };
  });
}
