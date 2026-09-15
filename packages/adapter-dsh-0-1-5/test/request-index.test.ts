import { describe, expect, it } from "vitest";
import type { CanonicalEventV1, JsonValue } from "@linmu/dsh-session-contracts";
import { buildDshUserRequestIndex, dshUserRequestId, readDshUserRequestText } from "../src/request-index.js";

function event(id: string, type: string, content: JsonValue, sequence = 0, extra: Partial<CanonicalEventV1> = {}): CanonicalEventV1 {
  const kind = type === "user/message" ? "user-message" : type === "assistant/message" ? "assistant-message" : "system-metadata";
  return { schemaVersion: 1, id, logicalSessionId: "logical-source" as never, sequence, kind,
    role: kind === "user-message" ? "user" : kind === "assistant-message" ? "assistant" : "system", content,
    source: { platform: "dsh", instanceId: "fixture", sessionId: "native-source", eventId: String(sequence), cursor: null },
    contentDigest: `digest-${id}`, rawPayload: { type, seq: sequence, time: 1000 + sequence, surfaceOp: "append" },
    extensions: { dshEventType: type, nativeFormatVersion: 3 }, ...extra };
}
const user = (id: string, text: string, source: JsonValue = { kind: "user" }) => event(id, "user/message", { id, role: "user", source, content: [{ type: "text", text }] });
const assistant = (id: string, turn = 1, step = 1) => event(id, "assistant/message", { turn, step, message: { id, role: "assistant", content: [{ type: "text", text: "ANSWER-BODY-MUST-NOT-BE-IN-INDEX" }] } });

describe("DSH native user request index", () => {
  it("classifies trusted sources, preserves pasted tags and hides unverifiable legacy text", () => {
    const events = [
      user("real", "Current runtime context. <available_skills> pasted text"),
      user("runtime", "injected", { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" }),
      user("skills", "catalog", { kind: "skill-catalog", form: "catalog" }),
      user("annotation", "reference", { kind: "dsh-annotation", schemaVersion: 1, count: 1, setId: "set", targetUserMessageId: "real", digest: "hash" }),
      user("plugin", "plugin context", { kind: "plugin", plugin: "fixture" }),
      user("submitted-by-plugin", "actual user submission", { kind: "user", rpcId: "trusted-submit" }),
      user("legacy", "UNVERIFIED-MUST-NOT-BE-PROMOTED", {}),
      user("release-record", "released source locator", { kind: "dsh-native-context-release", plugin: "dsh-annotation-core", protocolVersion: 1 }),
    ];
    const index = buildDshUserRequestIndex(events);
    expect(index.map(row => [row.eventId, row.sourceTrust])).toEqual([["real", "verified"], ["submitted-by-plugin", "verified"], ["legacy", "unverified"]]);
    expect(readDshUserRequestText(events[0]!).text).toContain("<available_skills>");
    expect(JSON.stringify(index)).not.toContain("UNVERIFIED-MUST-NOT-BE-PROMOTED");
    expect(index[2]).toMatchObject({ state: "unknown", associationState: "unknown" });
  });

  it("keeps supplements in the native execution and reports failed or cancelled execution without inferring success", () => {
    const events = [
      user("queued", "queued initial"), event("start", "turn/start", { turn: 1 }),
      user("supplement", "add this during execution"), assistant("answer"),
      event("step-end", "step/end", { turn: 1, step: 1 }), event("end", "turn/end", { turn: 1, reason: { kind: "failed" } }),
      event("retry-start", "turn/start", { turn: 2 }), user("retry", "retry request"),
      event("retry-end", "turn/end", { turn: 2, reason: { kind: "cancelled" } }),
      user("pending", "submitted but no execution yet"),
    ];
    const index = buildDshUserRequestIndex(events);
    expect(index.map(row => row.state)).toEqual(["failed", "failed", "cancelled", "pending"]);
    expect(index[0]!.executionRefs).toEqual(index[1]!.executionRefs);
    expect(index.map(row => row.relation)).toEqual(["initial", "supplement", "initial", "unknown"]);
    expect(index[0]).toMatchObject({ startEventId: "queued", endEventId: "answer", replyEventId: "answer", rangeState: "complete" });
    expect(index[1]).toMatchObject({ startEventId: "queued", endEventId: "answer", turnBoundaryEventId: "start" });
    expect(JSON.stringify(index)).not.toContain("ANSWER-BODY");
  });

  it("uses canonical event identity rather than ordinal or reader grouping, and does not index replacement copies", () => {
    const original = user("original", "request"), replacement = { ...user("released-copy", "compact handle"), rawPayload: { surfaceOp: "replace" } };
    const one = buildDshUserRequestIndex([original]);
    const reordered = buildDshUserRequestIndex([user("earlier", "earlier"), original, replacement]);
    expect(one[0]!.requestId).toBe(reordered[1]!.requestId);
    expect(reordered.map(row => row.eventId)).toEqual(["earlier", "original"]);
    expect(dshUserRequestId(original)).not.toBe(dshUserRequestId({ ...original, logicalSessionId: "forked-session" as never }));
  });

  it("uses MCSF topology and does not invent execution boundaries from each user message", () => {
    const topology = { schemaVersion: 1, turnId: "stable-turn", turnOrdinal: 8, stepId: null, stepOrdinal: null, phase: "user", inference: "explicit" };
    const a = user("request-a", "first"), b = user("request-b", "second");
    const indexed = buildDshUserRequestIndex([a, b].map(value => ({ ...value, extensions: { ...value.extensions, "mcsf.conversationTopology.v1": topology } as never })));
    expect(indexed.map(row => row.turnId)).toEqual(["stable-turn", "stable-turn"]);
    expect(indexed[0]!.executionRefs).toEqual(indexed[1]!.executionRefs);
    expect(indexed[1]!.relation).toBe("supplement");
    expect(indexed[0]!.state).toBe("unknown");
  });

  it("pages long Unicode text exactly and returns only attachment identities", () => {
    const text = "long😀代码\n".repeat(12000), source = user("long", text);
    let joined = "", offset: number | null = 0;
    while (offset !== null) { const page = readDshUserRequestText(source, offset, 327); joined += page.text; offset = page.nextOffset; }
    expect(joined).toBe(text);
    expect(readDshUserRequestText(source, 0, 1).totalChars).toBe([...text].length);
    expect(() => readDshUserRequestText(source, [...text].length + 1, 1)).toThrow("超出末尾");
    const attached = event("attachment-only", "user/message", { id: "attachment-only", role: "user", source: { kind: "user" }, content: [
      { type: "image", id: "img-1", name: "图.png", mimeType: "image/png", data: "PRIVATE-IMAGE-DATA" },
      { type: "file", name: "test.txt", content: "PRIVATE-FILE-DATA" },
    ] });
    expect(readDshUserRequestText(attached)).toEqual({ text: "", totalChars: 0, nextOffset: null });
    const index = buildDshUserRequestIndex([attached]);
    expect(index[0]!.attachmentRefs).toHaveLength(2);
    expect(JSON.stringify(index)).not.toContain("PRIVATE-");
  });

  it("never computes association from beyond the authorized cutoff", () => {
    const prefix = [event("start", "turn/start", { turn: 1 }), user("q", "safe"), assistant("cutoff")];
    const index = buildDshUserRequestIndex(prefix, { completedCutoffEventId: "cutoff" });
    expect(index[0]).toMatchObject({ endEventId: "cutoff", replyEventId: "cutoff", rangeState: "complete", state: "running" });
    expect(index[0]!.executionRefs[0]!.endEventId).toBeNull();
  });
  it("does not assign an earlier completed reply to a later supplement in the same execution", () => {
    const index = buildDshUserRequestIndex([event("start", "turn/start", { turn: 1 }), user("first", "initial"), assistant("earlier-answer"),
      event("step-end", "step/end", { turn: 1, step: 1 }), user("later", "a new constraint")]);
    expect(index[0]!.replyEventId).toBe("earlier-answer");
    expect(index[1]).toMatchObject({ state: "running", associationState: "partial", rangeState: "partial", replyRefs: [], replyEventId: null, endEventId: "later" });
  });
});
