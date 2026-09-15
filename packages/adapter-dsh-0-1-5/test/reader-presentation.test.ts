import { describe, expect, it } from "vitest";
import type { CanonicalEventV1, JsonValue, LogicalSessionId } from "@linmu/dsh-session-contracts";
import { readDshReaderPresentation } from "../src/reader-presentation.js";
import { normalizeV3Append } from "../src/normalize-append.js";

function event(content: JsonValue, overrides: Partial<CanonicalEventV1> = {}): CanonicalEventV1 {
  return {
    schemaVersion: 1, id: "fixture-event", logicalSessionId: "fixture-session" as LogicalSessionId,
    sequence: 0, kind: "user-message", role: "user", content, contentDigest: "fixture-digest", rawPayload: null,
    source: { platform: "dsh", instanceId: "fixture", sessionId: "fixture-native", eventId: "0", cursor: "1" },
    extensions: { adapterId: "dsh-0.1.5", dshEventType: "user/message" }, ...overrides,
  };
}

const runtimeSource = { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" };
const body = "Current runtime context. This snapshot supersedes earlier runtime-context snapshots. <available_skills> BODY-SECRET";

describe("DSH reader presentation metadata", () => {
  it("recognizes the root native runtime source without needing content or section bodies", () => {
    const input = event({ role: "user", source: { ...runtimeSource, form: "snapshot" } });
    expect(readDshReaderPresentation(input)).toEqual({ kind: "runtime-context", label: "运行上下文" });
  });

  it("recognizes native runtime clear events with no form", () => {
    expect(readDshReaderPresentation(event({ role: "user", source: runtimeSource })))
      .toEqual({ kind: "runtime-context", label: "运行上下文" });
  });

  it("requires the explicit skill catalog kind and form, not catalog prose or entries", () => {
    expect(readDshReaderPresentation(event({ role: "user", source: { kind: "skill-catalog", form: "catalog" } })))
      .toEqual({ kind: "skill-catalog", label: "技能目录" });
    for (const source of [{ kind: "skill-catalog" }, { kind: "plugin", plugin: "fixture", form: "catalog" }]) {
      expect(readDshReaderPresentation(event({ role: "user", source, content: [{ type: "text", text: body }] })).kind)
        .not.toBe("skill-catalog");
    }
  });

  it("keeps the same English runtime/catalog text as user content when source.kind is user", () => {
    expect(readDshReaderPresentation(event({ role: "user", source: { kind: "user" }, content: [{ type: "text", text: body }] })))
      .toEqual({ kind: "user", label: "用户" });
  });

  it("does not classify nested sources or unknown source kinds by text", () => {
    for (const content of [
      { role: "user", message: { source: runtimeSource }, content: [{ type: "text", text: body }] },
      { role: "user", source: { kind: "future-producer", plugin: runtimeSource.plugin }, content: body },
      { role: "user", source: { kind: "plugin", plugin: `${runtimeSource.plugin}-untrusted` } },
    ]) {
      expect(readDshReaderPresentation(event(content)).kind).not.toBe("runtime-context");
    }
  });

  it("requires a consistent DSH native user-message envelope for context classification", () => {
    const input = event({ role: "user", source: runtimeSource });
    for (const changed of [
      { ...input, source: { ...input.source, platform: "codex" as const } },
      { ...input, extensions: {} },
      { ...input, extensions: { dshEventType: "system/message" } },
      { ...input, kind: "system-metadata" as const, role: "system" as const },
      { ...input, content: { role: "assistant", source: runtimeSource } },
    ]) expect(readDshReaderPresentation(changed).kind).not.toBe("runtime-context");
  });

  it("labels explicit other plugin producers without exposing their source or body", () => {
    const input = event({ role: "user", source: { kind: "plugin", plugin: "fixture", form: "snapshot", sections: [{ name: "SECRET", text: body }] }, content: body });
    expect(readDshReaderPresentation(input)).toEqual({ kind: "plugin-context", label: "插件上下文" });
  });

  it("reads exact native tool call and result identities from their distinct fields", () => {
    const call = event({ turn: 1, step: 1, callId: "call-1", name: "read_file", arguments: body },
      { kind: "tool-call", role: "assistant", extensions: { dshEventType: "tool/call" } });
    const result = event({ callId: "wrong-root", message: { role: "user", source: { kind: "tool", callId: "call-1" }, content: [{ type: "tool-result", toolCallId: "wrong-block", content: body }] } },
      { kind: "tool-result", role: "tool", extensions: { dshEventType: "tool/result" } });
    expect(readDshReaderPresentation(call)).toEqual({ kind: "tool-call", label: "工具调用", toolCallId: "call-1", toolName: "read_file" });
    expect(readDshReaderPresentation(result)).toEqual({ kind: "tool-result", label: "工具结果", toolCallId: "call-1" });
  });

  it("does not invent tool correlation from result body or an unrelated source", () => {
    const input = event({ callId: "wrong-root", message: { source: { kind: "user", callId: "wrong-source" }, content: [{ type: "tool-result", toolCallId: "wrong-block" }] } },
      { kind: "tool-result", role: "tool", extensions: { dshEventType: "tool/result" } });
    expect(readDshReaderPresentation(input)).toEqual({ kind: "tool-result", label: "工具结果" });
    expect(readDshReaderPresentation(event({ callId: "\nsecret", name: "x".repeat(513) }, { kind: "tool-call" })))
      .toEqual({ kind: "tool-call", label: "工具调用" });
  });

  it("uses existing canonical semantics for portable records and never turns process controls into answers", () => {
    for (const [kind, expected] of [
      ["assistant-message", "assistant"], ["reasoning", "reasoning"], ["system-metadata", "record"], ["other", "record"],
    ] as const) expect(readDshReaderPresentation(event(null, { kind })).kind).toBe(expected);
    expect(readDshReaderPresentation(event({ callId: "portable-call" }, { kind: "tool-result", extensions: {} })))
      .toEqual({ kind: "tool-result", label: "工具结果", toolCallId: "portable-call" });
  });

  it("classifies a normalized synthetic RC2 event without changing the canonical payload", async () => {
    const data = { id: "runtime-1", role: "user", source: { ...runtimeSource, form: "snapshot", sections: [{ name: "workspace", text: body }] }, content: [{ type: "text", text: body }] };
    const normalized = await normalizeV3Append({
      runId: "fixture-run", nativeSessionId: "fixture-native", operationId: "fixture-operation", nativeRevision: 1,
      observedAt: "2026-09-15T00:00:00Z", payload: { logicalSessionId: "fixture-session", instanceId: "fixture",
        header: { version: 3, id: "fixture-native", createdAt: 1, delegationDepth: 0, isSeeded: false }, inheritedEventCount: 0, events: [
        { seq: 0, time: 1, type: "user/message", surfaceOp: "append", data },
      ] },
    });
    const input = normalized.events[0]!;
    const before = structuredClone(input);
    Object.freeze(input.content);
    Object.freeze(input);
    expect(readDshReaderPresentation(input)).toEqual({ kind: "runtime-context", label: "运行上下文" });
    expect(input).toEqual(before);
    expect(input.kind).toBe("user-message");
    expect(input.role).toBe("user");
    expect(input.content).toEqual(data);
  });
});
