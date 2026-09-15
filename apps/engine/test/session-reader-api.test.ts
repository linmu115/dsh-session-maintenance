import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalEventV1, JsonValue } from "../../../packages/contracts/src/index.js";
import { canonicalEventProjectionPolicy } from "../../../packages/contracts/src/index.js";
import { MaintenanceClient } from "../../../packages/local-api-client/src/index.js";
import { SqliteCanonicalRepository } from "../../../packages/session-store/src/index.js";
import { createEngineFixture } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
const at = "2026-09-16T00:00:00.000Z";
function event(sequence: number, kind: CanonicalEventV1["kind"], content: JsonValue, nativeType: string): CanonicalEventV1 {
  return { schemaVersion: 1, id: `event-${sequence}`, logicalSessionId: "reader-session" as never, sequence, kind,
    role: kind === "user-message" ? "user" : kind === "tool-result" ? "tool" : kind === "assistant-message" || kind === "tool-call" ? "assistant" : "system",
    content, contentDigest: `digest-${sequence}`, rawPayload: { type: nativeType, data: content },
    source: { platform: "dsh", instanceId: "synthetic", sessionId: "native-reader", eventId: String(sequence), cursor: String(sequence) }, extensions: { dshEventType: nativeType } };
}
const message = (role: string, text: string, source: JsonValue = { kind: "user" }) => ({ id: `message-${text.slice(0, 5)}`, role, content: [{ type: "text", text }], source });
async function fixture(events: CanonicalEventV1[]) {
  const f = await createEngineFixture("synthetic-paged-reader"); cleanups.push(f.cleanupAll);
  const canonical = new SqliteCanonicalRepository(f.engine.repository.database);
  await canonical.createCanonicalSession({ schemaVersion: 1, id: "reader-session" as never, authorityScope: "maintenance", originKind: "maintenance-native", headVersionId: null,
    title: "Synthetic reader", tags: [], archivedAt: null, tombstonedAt: null, createdAt: at, updatedAt: at });
  for (const e of events) await canonical.putCanonicalEvent(e);
  const server = await f.startServer();
  return { ...f, canonical, server, client: new MaintenanceClient({ origin: server.origin, token: server.token }) };
}

describe("bounded canonical reader", () => {
  it("keeps literal user input and final answers, folding attributed context and pairing tools without loading their bodies", async () => {
    const literal = "Current runtime context. <available_skills> pasted by the user";
    const large = "TOOL_PRIVATE_BODY ".repeat(80_000);
    const events = [event(0, "system-metadata", { name: "start" }, "agent/turn-start"),
      event(1, "user-message", message("user", literal), "user/message"),
      event(2, "user-message", message("user", "AUTOMATIC_RUNTIME_BODY", { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt", form: "snapshot", sections: [{ name: "policy", text: large }] }), "user/message"),
      event(3, "user-message", message("user", "AUTOMATIC_SKILLS_BODY", { kind: "skill-catalog", form: "catalog", entries: [] }), "user/message"),
      event(4, "assistant-message", { turn: 1, step: 0, message: message("assistant", "INTERMEDIATE_BODY") }, "assistant/message"),
      event(5, "tool-call", { callId: "call-a", name: "search", arguments: large }, "tool/call"),
      event(6, "tool-result", { outputText: large, message: { source: { kind: "tool", callId: "call-a" } } }, "tool/result"),
      event(7, "assistant-message", { turn: 1, step: 1, message: message("assistant", "完整最终回答") }, "assistant/message"),
      event(8, "user-message", message("user", "第二个完整问题"), "user/message"),
      event(9, "assistant-message", { turn: 2, step: 0, message: message("assistant", "第二个完整回答") }, "assistant/message")];
    const f = await fixture(events);
    const before = f.engine.repository.database.prepare("SELECT event_json FROM canonical_events ORDER BY sequence").all();
    const legacy = vi.spyOn(f.engine.sessionQueries, "readCanonicalDashboardSession");
    const first = await f.client.getSessionReader("reader-session", { limit: 1 });
    expect(legacy).toHaveBeenCalledWith("reader-session", false);
    expect(first.turns).toHaveLength(1);
    expect(first.turns[0]?.messages.map(m => m.text)).toEqual([literal, "完整最终回答"]);
    expect(first.turns[0]?.processCount).toBe(6);
    expect(JSON.stringify(first)).not.toContain("TOOL_PRIVATE_BODY");
    expect(JSON.stringify(first)).not.toContain("AUTOMATIC_RUNTIME_BODY");
    expect(JSON.stringify(first)).not.toContain("INTERMEDIATE_BODY");
    expect("events" in first.detail).toBe(false);
    const process = await f.client.getSessionReaderProcess("reader-session", { snapshot: first.snapshot, turnId: first.turns[0]!.id });
    expect(process.items.find(item => item.kind === "tool-call")?.eventIds).toEqual(["event-5", "event-6"]);
    expect(process.items.find(item => item.kind === "tool-call")?.paired).toBe(true);
    expect(JSON.stringify(process)).not.toContain("TOOL_PRIVATE_BODY");
    expect(process.items.map(item => item.kind)).toEqual(["record", "runtime-context", "skill-catalog", "assistant", "tool-call"]);
    const second = await f.client.getSessionReader("reader-session", { snapshot: first.snapshot, cursor: first.nextCursor!, limit: 1 });
    expect(second.turns[0]?.messages.map(m => m.text)).toEqual(["第二个完整问题", "第二个完整回答"]);
    expect(second.nextCursor).toBeNull();
    const part = await f.client.getSessionReaderEvent("reader-session", "event-6", { snapshot: first.snapshot, limit: 1024 });
    expect(part.text).toHaveLength(1024); expect(part.totalChars).toBe(large.length); expect(part.nextOffset).toBe(1024);
    expect(f.engine.repository.database.prepare("SELECT event_json FROM canonical_events ORDER BY sequence").all()).toEqual(before);
    expect(events.map(e => canonicalEventProjectionPolicy(e.kind))).toEqual(before.map(row => canonicalEventProjectionPolicy(JSON.parse(String(row.event_json)).kind)));
    expect((await f.client.getCanonicalSession("reader-session")).events).toHaveLength(10);
  });

  it("pages the complete Unicode message and raw evidence without truncation or duplicate characters", async () => {
    const text = "你好🙂".repeat(6000);
    const f = await fixture([event(0, "user-message", message("user", text), "user/message")]);
    const first = await f.client.getSessionReader("reader-session"); let combined = first.turns[0]!.messages[0]!.text;
    let next = first.turns[0]!.messages[0]!.nextOffset;
    while (next !== null) { const page = await f.client.getSessionReaderEvent("reader-session", "event-0", { snapshot: first.snapshot, offset: next, limit: 2000 }); combined += page.text; next = page.nextOffset; }
    expect(combined).toBe(text);
    const raw = await f.client.getSessionReaderEvent("reader-session", "event-0", { snapshot: first.snapshot, format: "raw", limit: 128 });
    expect([...raw.text]).toHaveLength(128); expect(raw.nextOffset).toBe(128); expect(raw.totalChars).toBeGreaterThan(10_000);
  });

  it.each([false, true])("attaches pending preparation to the following user without moving completed tool work (tools=%s)", async (withTools) => {
    const rows = [event(0, "user-message", message("user", "first question"), "user/message"),
      event(1, "assistant-message", { message: message("assistant", "first answer") }, "assistant/message")];
    if (withTools) rows.push(
      event(2, "user-message", message("user", "old runtime", { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" }), "user/message"),
      event(3, "tool-call", { callId: "old-call", name: "search" }, "tool/call"),
      event(4, "tool-result", { outputText: "old result", message: { source: { kind: "tool", callId: "old-call" } } }, "tool/result"));
    rows.push(event(5, "user-message", message("user", "new runtime", { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" }), "user/message"),
      event(6, "user-message", message("user", "new skills", { kind: "skill-catalog", form: "catalog" }), "user/message"),
      event(7, "user-message", message("user", "second question"), "user/message"),
      event(8, "assistant-message", { message: message("assistant", "second answer") }, "assistant/message"));
    const f = await fixture(rows), page = await f.client.getSessionReader("reader-session");
    expect(page.turns.map(turn => turn.messages.map(value => value.text))).toEqual([["first question", "first answer"], ["second question", "second answer"]]);
    expect(page.turns.map(turn => turn.processCount)).toEqual([withTools ? 3 : 0, 2]);
    const first = await f.client.getSessionReaderProcess("reader-session", { snapshot: page.snapshot, turnId: page.turns[0]!.id });
    const second = await f.client.getSessionReaderProcess("reader-session", { snapshot: page.snapshot, turnId: page.turns[1]!.id });
    expect(first.items.map(item => item.eventIds)).toEqual(withTools ? [["event-2"], ["event-3", "event-4"]] : []);
    expect(second.items.map(item => item.eventIds)).toEqual([["event-5"], ["event-6"]]);
  });

  it("requires the same snapshot, validates bounds, checks session membership and authenticates every reader route", async () => {
    const f = await fixture([event(0, "user-message", message("user", "first"), "user/message")]);
    const page = await f.client.getSessionReader("reader-session");
    expect((await fetch(`${f.server.origin}/v1/canonical/sessions/reader-session/reader`)).status).toBe(401);
    await expect(f.client.getSessionReader("reader-session", { limit: 11 })).rejects.toThrow();
    await expect(f.client.getSessionReader("reader-session", { cursor: "1" })).rejects.toThrow("快照");
    await expect(f.client.getSessionReaderEvent("reader-session", "not-in-session", { snapshot: page.snapshot })).rejects.toThrow("不存在");
    await expect(f.client.getSessionReaderEvent("reader-session", "event-0", { snapshot: page.snapshot, offset: 1000 })).rejects.toThrow("末尾");
    await f.canonical.putCanonicalEvent(event(1, "assistant-message", { message: message("assistant", "new answer") }, "assistant/message"));
    await expect(f.client.getSessionReaderEvent("reader-session", "event-0", { snapshot: page.snapshot })).rejects.toThrow("已有更新");
  });

  it("paginates process groups without dropping unpaired results", async () => {
    const f = await fixture([event(0, "user-message", message("user", "q"), "user/message"),
      ...Array.from({ length: 63 }, (_, i) => event(i + 1, "tool-result", { callId: `ignored-${i}`, outputText: "body", message: { source: { kind: "tool", callId: `missing-${i}` } } }, "tool/result"))]);
    const first = await f.client.getSessionReader("reader-session");
    const query = { snapshot: first.snapshot, turnId: first.turns[0]!.id, limit: 50 };
    const a = await f.client.getSessionReaderProcess("reader-session", query);
    const b = await f.client.getSessionReaderProcess("reader-session", { ...query, cursor: a.nextCursor! });
    expect(a.items).toHaveLength(50); expect(b.items).toHaveLength(13); expect(b.nextCursor).toBeNull();
    expect(new Set([...a.items, ...b.items].map(item => item.id)).size).toBe(63);
    expect([...a.items, ...b.items].every(item => !item.paired)).toBe(true);
  });
});
