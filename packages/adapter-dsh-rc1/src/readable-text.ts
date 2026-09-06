import type { CanonicalEventV1, JsonValue } from "@linmu/dsh-session-adapter-sdk";

function record(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageText(content: JsonValue): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content.map(messageText).filter((value): value is string => value !== null);
    return parts.length > 0 ? parts.join("\n\n") : null;
  }
  if (!record(content)) return null;
  if (typeof content.type === "string" && !["text", "input_text", "output_text"].includes(content.type)) return null;
  if (typeof content.text === "string") return content.text;
  return content.content === undefined ? null : messageText(content.content);
}

/** Read-only presentation of saved DSH content; never changes native/canonical evidence. */
export function readRc1CanonicalEventText(event: CanonicalEventV1): string | null {
  if (event.source.platform !== "dsh" || event.kind === "other" || event.kind === "opaque-unknown") return null;
  const content = event.content;
  // Native assistant/message retains event.data. Unwrap only this known root
  // envelope; messageText never searches message/source/metadata recursively.
  if (event.kind === "assistant-message" && event.role === "assistant" && record(content)
    && content.type === undefined && typeof content.turn === "number" && typeof content.step === "number"
    && record(content.message) && typeof content.message.id === "string"
    && content.message.role === "assistant" && Array.isArray(content.message.content)) {
    return messageText(content.message.content);
  }
  return messageText(content);
}
