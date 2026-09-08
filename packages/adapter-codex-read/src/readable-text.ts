import type { CanonicalEventV1, JsonValue } from "@linmu/dsh-session-contracts";

const textKinds = new Set(["user-message", "assistant-message", "system-message", "reasoning"]);
type TextEvent = Pick<CanonicalEventV1, "kind" | "content"> & {
  readonly source: Pick<CanonicalEventV1["source"], "platform">;
};
function record(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads saved Codex canonical text without changing content or inspecting raw evidence. */
export function readCodexCanonicalEventText(event: TextEvent): string | null {
  if (event.source.platform !== "codex" || !textKinds.has(event.kind)) return null;
  const content = event.content;
  const text = typeof content === "string" ? content
    : record(content) && content.type === undefined && typeof content.text === "string" ? content.text : null;
  return text === "" ? null : text;
}
