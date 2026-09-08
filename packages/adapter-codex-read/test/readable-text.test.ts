import { describe, expect, it } from "vitest";
import type { CanonicalEventV1, JsonValue } from "@linmu/dsh-session-contracts";
import { readCodexCanonicalEventText } from "../src/index.js";

function event(content: JsonValue): CanonicalEventV1 {
  return { schemaVersion: 1, id: "synthetic-readable", logicalSessionId: "synthetic-session" as never,
    sequence: 0, kind: "assistant-message", role: "assistant", content, contentDigest: "sha256:synthetic",
    source: { platform: "codex", instanceId: "synthetic", sessionId: "synthetic-native", eventId: null, cursor: null },
    rawPayload: null, extensions: {} };
}

describe("read-only Codex canonical text", () => {
  it.each([
    ["legacy string", " 旧正文\r\n第二行 ", " 旧正文\r\n第二行 "],
    ["canonical object", { text: "## 标题\n\n**正文** 😀", attachments: [] }, "## 标题\n\n**正文** 😀"],
    ["text with attachment", { text: "说明", attachments: [{ source: "file:///image.png" }] }, "说明"],
    ["empty text", { text: "", attachments: [] }, null],
    ["image only", { text: "", attachments: [{ text: "image metadata", source: "https://example.invalid/image.png" }] }, null],
    ["unknown wrapper", { metadata: { text: "hidden" }, source: { text: "hidden" } }, null],
    ["tool payload", { type: "tool-call", text: "tool arguments" }, null],
    ["native array", [{ type: "output_text", text: "unrecognized shape" }], null],
    ["invalid text", { text: 42 }, null],
  ] as const)("handles %s without rewriting evidence", (_name, content, expected) => {
    const saved = event(content as JsonValue);
    const before = JSON.stringify(saved);
    expect(readCodexCanonicalEventText(saved)).toBe(expected);
    expect(JSON.stringify(saved)).toBe(before);
  });

  it("keeps text records distinct from tools, unknown evidence and other platforms", () => {
    for (const [kind, role] of [["user-message", "user"], ["assistant-message", "assistant"], ["system-message", "system"], ["reasoning", "assistant"]] as const) {
      expect(readCodexCanonicalEventText({ ...event({ text: "visible" }), kind, role })).toBe("visible");
    }
    for (const kind of ["other", "opaque-unknown", "tool-call", "tool-result", "attachment", "system-metadata"] as const) {
      expect(readCodexCanonicalEventText({ ...event({ text: "not message text" }), kind })).toBeNull();
    }
    const dsh = event({ text: "DSH uses its own reader" });
    expect(readCodexCanonicalEventText({ ...dsh, source: { ...dsh.source, platform: "dsh" } })).toBeNull();
  });
});
