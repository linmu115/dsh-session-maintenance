import { describe, expect, it } from "vitest";
import { parseLearningLog } from "../src/learning.js";
const at = "2026-09-17T00:01:00Z";
const row = (type: string, payload: unknown, timestamp = at) => JSON.stringify({ type, payload, timestamp }) + "\n";
const msg = (role: string, text: string) => row("response_item", { type: "message", id: role, role, content: [{ type: role === "user" ? "input_text" : "output_text", text }], internal_chat_message_metadata_passthrough: { turn_id: "turn" } });
describe("Codex learning log boundary", () => {
  it("excludes runtime environment envelopes while retaining a mixed user request", () => {
    const result = parseLearningLog(msg("user", "<environment_context>runtime</environment_context>")
      + msg("user", "<environment_context>runtime</environment_context>\nQuestion"));
    expect(result.messages.map(m => m.text)).toEqual(["Question"]);
    expect(parseLearningLog(msg("user", "    indented code\n")).messages[0]!.text).toBe("    indented code\n");
  });
  it("excludes internal reasoning and records a complete post-boundary pair", () => {
    const base = row("session_meta", { id: "fixture" });
    const cursor = parseLearningLog(base).cursor;
    const log = base + row("event_msg", { type: "task_started", turn_id: "turn" }) + msg("user", "question")
      + row("response_item", { type: "reasoning", summary: [{ text: "private" }] }) + msg("assistant", "answer")
      + row("event_msg", { type: "task_complete", turn_id: "turn" }, "2026-09-17T00:02:00Z");
    const result = parseLearningLog(log, cursor);
    expect(result.busy).toBe(false); expect(result.messages.map(m => m.text)).toEqual(["question", "answer"]);
    expect(result.messages.every(m => m.startedAt === at && m.completedAt === "2026-09-17T00:02:00Z")).toBe(true);
  });
  it("rejects rewritten prefixes, partial writes, rollback, tool execution and images", () => {
    const base = row("session_meta", { id: "fixture" }), cursor = parseLearningLog(base).cursor;
    expect(() => parseLearningLog(base.replace("fixture", "changed"), cursor)).toThrow("历史发生变化");
    expect(() => parseLearningLog(base.slice(0, -1))).toThrow("仍在写入");
    expect(() => parseLearningLog(base + row("compacted", {}), cursor)).toThrow("压缩");
    expect(() => parseLearningLog(base + row("response_item", { type: "function_call", name: "tool" }), cursor)).toThrow("工具执行");
    expect(() => parseLearningLog(base + row("response_item", { type: "message", role: "user", content: [{ type: "input_image", image_url: "fixture" }] }))).toThrow("图片");
  });
  it("does not mistake imported messages without a generation for new completed turns", () => {
    const result = parseLearningLog(msg("user", "imported") + msg("assistant", "imported answer"));
    expect(result.messages.every(m => m.startedAt === null && m.completedAt === null)).toBe(true);
  });
});
