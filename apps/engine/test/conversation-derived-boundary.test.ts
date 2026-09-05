import { describe, expect, it } from "vitest";

import type { CanonicalEventV1, LogicalSessionId } from "@linmu/dsh-session-contracts";

import { assertDerivedParentForkBoundary } from "../src/conversation-derived-boundary.js";

const childId = "derived-boundary-fixture" as LogicalSessionId;

function event(eventId: string | null, sequence = 0): CanonicalEventV1 {
  return {
    schemaVersion: 1,
    id: `canonical-${eventId}`,
    logicalSessionId: "parent-boundary-fixture" as LogicalSessionId,
    sequence,
    kind: "user-message",
    role: "user",
    content: { text: "fixture input" },
    source: { platform: "codex", instanceId: "fixture", sessionId: "parent", eventId, cursor: String(sequence) },
    contentDigest: "old-digest",
    rawPayload: null,
    extensions: {},
  };
}

describe("derived conversation immutable fork boundary", () => {
  it("accepts normalized identities, content and cursors while retaining source order", () => {
    const base = [event("compaction-boundary"), event("first", 1), event("log-only", 2), event("last", 3)];
    const repaired = [base[1]!, base[3]!].map((original, sequence) => ({
      ...original,
      id: `repaired-${sequence}`,
      sequence,
      content: { text: "normalized fixture input" },
      contentDigest: "new-digest",
      source: { ...original.source, cursor: String(sequence) },
    }));
    expect(() => assertDerivedParentForkBoundary(base, repaired, childId)).not.toThrow();
  });

  it("rejects future parent history even if canonical identity and digest appear unchanged", () => {
    const original = event("at-fork");
    const future = { ...original, source: { ...original.source, eventId: "after-fork" } };
    expect(() => assertDerivedParentForkBoundary([original], [original, future], childId))
      .toThrow("does not contain a repaired parent source event");
  });

  it("rejects reordered occurrences rather than treating sources as an unordered set", () => {
    const base = [event("first"), event("second", 1)];
    expect(() => assertDerivedParentForkBoundary(base, [base[1]!, base[0]!], childId))
      .toThrow("reorders parent source events");
  });

  it.each(["platform", "instanceId", "sessionId"] as const)("includes %s in the source identity", (field) => {
    const original = event("shared-id");
    const changed = {
      ...original,
      source: { ...original.source, [field]: field === "platform" ? "dsh" : "another-source" },
    } as CanonicalEventV1;
    expect(() => assertDerivedParentForkBoundary([original], [changed], childId))
      .toThrow("does not contain a repaired parent source event");
  });

  it.each(["base", "repaired"] as const)("rejects duplicate source occurrences in the %s", (side) => {
    const original = event("repeated");
    const duplicate = { ...original, id: "different-canonical-id", sequence: 1 };
    expect(() => assertDerivedParentForkBoundary(
      side === "base" ? [original, duplicate] : [original],
      side === "repaired" ? [original, duplicate] : [original],
      childId,
    )).toThrow(`duplicate ${side} source events`);
  });

  it.each([
    { side: "base", eventId: null },
    { side: "base", eventId: "" },
    { side: "repaired", eventId: null },
    { side: "repaired", eventId: "   " },
  ])("rejects missing source identity in the $side ($eventId)", ({ side, eventId }) => {
    expect(() => assertDerivedParentForkBoundary(
      [event(side === "base" ? eventId : "identified")],
      [event(side === "repaired" ? eventId : "identified")],
      childId,
    )).toThrow("unidentified source event");
  });
});
