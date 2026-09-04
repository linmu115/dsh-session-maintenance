import { describe, expect, it } from "vitest";

import {
  CANONICAL_CONVERSATION_TOPOLOGY_EXTENSION,
  type CanonicalConversationTopologyV1,
  type CanonicalEventKind,
  type CanonicalEventRole,
  type CanonicalEventV1,
  type JsonValue,
} from "@linmu/dsh-session-contracts";

import { planConversationTopology } from "../src/index.js";

function event(
  id: string,
  sequence: number,
  kind: CanonicalEventKind,
  role: CanonicalEventRole,
  content: JsonValue,
  topology?: CanonicalConversationTopologyV1,
): CanonicalEventV1 {
  return {
    schemaVersion: 1,
    id,
    logicalSessionId: "logical-topology-fixture" as never,
    sequence,
    kind,
    role,
    content,
    source: {
      platform: "codex",
      instanceId: "codex-fixture",
      sessionId: "thread-fixture",
      eventId: id,
      cursor: String(sequence),
    },
    contentDigest: `digest-${id}`,
    rawPayload: null,
    extensions: topology === undefined
      ? {}
      : { [CANONICAL_CONVERSATION_TOPOLOGY_EXTENSION]: topology },
  };
}

describe("conversation topology planning", () => {
  it("derives two turns while preserving canonical encounter order", () => {
    const events = [
      event("user-1", 10, "user-message", "user", "first"),
      event("metadata", 11, "system-metadata", "system", { internal: true }),
      event("assistant-1", 12, "assistant-message", "assistant", "answer one"),
      event("user-2", 20, "user-message", "user", "second"),
      event("assistant-2", 21, "assistant-message", "assistant", "answer two"),
    ];

    const plan = planConversationTopology(events);

    expect(plan.events.map((item) => item.eventId)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
      "assistant-2",
    ]);
    expect(plan.turns.map((turn) => turn.eventIds)).toEqual([
      ["user-1", "assistant-1"],
      ["user-2", "assistant-2"],
    ]);
    expect(plan.events.map((item) => item.topology.turnOrdinal)).toEqual([0, 0, 1, 1]);
    expect(plan.diagnostics).toMatchObject({
      inputEventCount: 5,
      conversationalEventCount: 4,
      unassignedEventCount: 1,
      turnCount: 2,
      stepCount: 2,
    });
  });

  it("advances the model step only after every tool result closes its call", () => {
    const plan = planConversationTopology([
      event("user", 0, "user-message", "user", "run both"),
      event("call-a", 1, "tool-call", "assistant", { callId: "call-a", name: "one" }),
      event("call-b", 2, "tool-call", "assistant", { callId: "call-b", name: "two" }),
      event("result-a", 3, "tool-result", "tool", { callId: "call-a", outputText: "a" }),
      event("result-b", 4, "tool-result", "tool", { callId: "call-b", outputText: "b" }),
      event("reasoning", 5, "reasoning", "assistant", "combine"),
      event("assistant", 6, "assistant-message", "assistant", "done"),
    ]);

    expect(plan.events.map((item) => item.topology.stepOrdinal)).toEqual([0, 0, 0, 0, 0, 1, 1]);
    expect(plan.turns[0]?.steps.map((step) => step.eventIds)).toEqual([
      ["user", "call-a", "call-b", "result-a", "result-b"],
      ["reasoning", "assistant"],
    ]);
    expect(plan.continuationEligibility).toEqual({ status: "eligible", reasons: [] });
    expect(plan.diagnostics).toMatchObject({
      toolCallCount: 2,
      matchedToolResultCount: 2,
      orphanToolResultCount: 0,
      unclosedToolCallCount: 0,
    });
  });

  it("preserves valid explicit topology instead of replacing native knowledge", () => {
    const topology: CanonicalConversationTopologyV1 = {
      schemaVersion: 1,
      turnId: "turn-explicit",
      turnOrdinal: 7,
      stepId: "step-explicit",
      stepOrdinal: 4,
      phase: "assistant",
      inference: "explicit",
    };
    const plan = planConversationTopology([
      event("assistant-explicit", 88, "assistant-message", "assistant", "kept", topology),
    ]);

    expect(plan.events).toEqual([{
      eventId: "assistant-explicit",
      sequence: 88,
      kind: "assistant-message",
      topology,
    }]);
    expect(plan.turns[0]).toMatchObject({ turnId: "turn-explicit", turnOrdinal: 7 });
  });

  it("blocks continuation for an unclosed call without manufacturing a result", () => {
    const plan = planConversationTopology([
      event("user", 0, "user-message", "user", "run"),
      event("call", 1, "tool-call", "assistant", { callId: "call-open", name: "exec" }),
    ]);

    expect(plan.events.map((item) => item.kind)).toEqual(["user-message", "tool-call"]);
    expect(plan.continuationEligibility).toEqual({
      status: "blocked",
      reasons: [{ code: "unclosed-tool-call", eventIds: ["call"], callId: "call-open" }],
    });
    expect(plan.diagnostics.unclosedToolCallCount).toBe(1);
  });
});
