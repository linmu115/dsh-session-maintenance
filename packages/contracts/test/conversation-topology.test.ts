import { describe, expect, it } from "vitest";

import {
  CANONICAL_CONVERSATION_TOPOLOGY_EXTENSION,
  canonicalConversationTopologyV1Schema,
  canonicalEventV1Schema,
  parseCanonicalConversationTopologyV1,
  readCanonicalConversationTopologyV1,
  type CanonicalEventV1,
  type JsonValue,
} from "../src/index.js";

const explicitTopology = {
  schemaVersion: 1 as const,
  turnId: "turn-source-1",
  turnOrdinal: 3,
  stepId: "step-source-2",
  stepOrdinal: 2,
  phase: "assistant" as const,
  inference: "explicit" as const,
};

function eventWithExtension(value: JsonValue): Pick<CanonicalEventV1, "extensions"> {
  return { extensions: { [CANONICAL_CONVERSATION_TOPOLOGY_EXTENSION]: value } };
}

function canonicalEvent(topology: JsonValue): CanonicalEventV1 {
  return {
    schemaVersion: 1,
    id: "assistant-event",
    logicalSessionId: "logical-topology" as never,
    sequence: 0,
    kind: "assistant-message",
    role: "assistant",
    content: "answer",
    source: {
      platform: "codex",
      instanceId: "codex-fixture",
      sessionId: "thread-fixture",
      eventId: "assistant-event",
      cursor: "0",
    },
    contentDigest: "digest-assistant-event",
    rawPayload: null,
    extensions: { [CANONICAL_CONVERSATION_TOPOLOGY_EXTENSION]: topology },
  };
}

describe("canonical conversation topology contract", () => {
  it("round-trips a namespaced MCSF topology extension", () => {
    expect(parseCanonicalConversationTopologyV1(explicitTopology)).toEqual(explicitTopology);
    expect(readCanonicalConversationTopologyV1(eventWithExtension(explicitTopology))).toEqual(explicitTopology);
  });

  it("distinguishes an absent extension from a malformed present extension", () => {
    expect(readCanonicalConversationTopologyV1({ extensions: {} })).toBeNull();
    expect(() => readCanonicalConversationTopologyV1(eventWithExtension({
      ...explicitTopology,
      stepId: null,
    }))).toThrow(/step ID and ordinal/u);
  });

  it("rejects unsafe ordinals and unknown fields", () => {
    expect(canonicalConversationTopologyV1Schema.safeParse({
      ...explicitTopology,
      turnOrdinal: Number.MAX_SAFE_INTEGER + 1,
    }).success).toBe(false);
    expect(canonicalConversationTopologyV1Schema.safeParse({
      ...explicitTopology,
      nativeTurn: 99,
    }).success).toBe(false);
  });

  it("rejects a topology phase that contradicts its canonical event kind", () => {
    expect(canonicalEventV1Schema.safeParse(canonicalEvent({
      ...explicitTopology,
      phase: "user",
    })).success).toBe(false);
    expect(canonicalEventV1Schema.parse(canonicalEvent(explicitTopology))).toMatchObject({
      kind: "assistant-message",
    });
  });
});
