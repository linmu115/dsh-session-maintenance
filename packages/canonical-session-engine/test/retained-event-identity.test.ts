import { describe, expect, it } from "vitest";
import type { CanonicalEventV1 } from "@linmu/dsh-session-contracts";
import { retainCanonicalEventIdentities } from "../src/retained-event-identity.js";

function event(id: string, sourceId: string | null, patch: Partial<CanonicalEventV1> = {}): CanonicalEventV1 {
  return {
    schemaVersion: 1, id, logicalSessionId: "ls-test" as never, sequence: 0,
    kind: "assistant-message", role: "assistant", content: { text: "answer" },
    source: { platform: "codex", instanceId: "codex-main", sessionId: "task", eventId: sourceId, cursor: "0" },
    contentDigest: "sha256:fixture", rawPayload: null, extensions: {}, ...patch,
  };
}

describe("retained canonical source identity", () => {
  it("retains identity through filtering and semantic corrections without retaining old content", () => {
    const old = [event("old-1", "line-1"), event("removed", "line-2"), event("old-3", "line-3")];
    const fresh = [event("new-1", "line-1", { content: { text: "corrected" } }),
      event("new-3", "line-3", { sequence: 1, extensions: { parentEventId: "new-1", fresh: true } }),
      event("new-4", "line-4", { sequence: 2 })];
    const before = JSON.stringify({ old, fresh });
    const result = retainCanonicalEventIdentities(old, fresh);
    expect(result.map((item) => item.id)).toEqual(["old-1", "old-3", "new-4"]);
    expect(result[0]?.content).toEqual({ text: "corrected" });
    expect(result[1]?.extensions).toEqual({ parentEventId: "old-1", fresh: true });
    expect(JSON.stringify({ old, fresh })).toBe(before);
    expect(retainCanonicalEventIdentities(result, fresh)).toEqual(result);
  });

  it.each(["platform", "instanceId", "sessionId", "eventId"] as const)("does not conflate another source %s", (field) => {
    const old = event("old", "line-1");
    const fresh = event("new", "line-1", { source: { ...old.source, [field]: field === "platform" ? "dsh" : "different" } });
    expect(retainCanonicalEventIdentities([old], [fresh])[0]?.id).toBe("new");
  });

  it("does not guess identities from content when source identity is absent", () => {
    expect(retainCanonicalEventIdentities([event("old", null)], [event("new", null)])[0]?.id).toBe("new");
  });

  it("rejects ambiguous sources, incoming IDs and target collisions", () => {
    expect(() => retainCanonicalEventIdentities([event("a", "1"), event("b", "1")], []))
      .toThrow("previous version");
    expect(() => retainCanonicalEventIdentities([], [event("a", "1"), event("b", "1")]))
      .toThrow("incoming version");
    expect(() => retainCanonicalEventIdentities([], [event("a", "1"), event("a", "2")]))
      .toThrow("Duplicate incoming");
    expect(() => retainCanonicalEventIdentities([event("old", "1")], [event("new", "1"), event("old", "2")]))
      .toThrow("collides");
  });
});
