import { describe, expect, it } from "vitest";

import type { CanonicalEventV1 } from "@linmu/dsh-session-adapter-sdk";

import { materializeEvent } from "../src/materialize.js";

function event(
  id: string,
  sequence: number,
  kind: "tool-call" | "tool-result",
  role: "assistant" | "tool",
  content: CanonicalEventV1["content"],
): CanonicalEventV1 {
  return {
    schemaVersion: 1,
    id,
    logicalSessionId: "ls-codex-tool" as never,
    sequence,
    kind,
    role,
    content,
    source: { platform: "codex", instanceId: "codex-main", sessionId: "thread", eventId: id, cursor: String(sequence) },
    contentDigest: `digest-${id}`,
    rawPayload: null,
    extensions: {},
  };
}

describe("Alpha2 Codex tool projection", () => {
  it("emits native tool/call and tool/result events with preserved correlation", () => {
    const call = materializeEvent(event("call-event", 0, "tool-call", "assistant", {
      callId: "call-1",
      name: "exec",
      protocol: "custom",
      arguments: "do work",
    }), 1000);
    const result = materializeEvent(event("result-event", 1, "tool-result", "tool", {
      callId: "call-1",
      name: "exec",
      protocol: "custom",
      outputText: "done",
    }), 1000);

    expect(call).toEqual({
      type: "tool/call",
      seq: 0,
      time: 1000,
      data: { turn: 0, step: 0, callId: "call-1", name: "exec", arguments: "do work" },
    });
    expect(result).toMatchObject({
      type: "tool/result",
      seq: 1,
      time: 1001,
      surfaceOp: "append",
      data: {
        message: {
          role: "user",
          source: { kind: "tool", callId: "call-1" },
          content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "done" }] }],
        },
      },
    });
  });
});
