import { describe, expect, it } from "vitest";
import { v3SessionGraph } from "../src/session-graph.js";
import { normalizeV3Append } from "../src/normalize-append.js";
import { contextEvents, contextHeader } from "./context-fixture.js";

describe("RC2 graph completed turns", () => {
  it("offers completed turns newest first and excludes streaming tail, system and intermediate tool material", async () => {
    const events = contextEvents();
    const canonical = await normalizeV3Append({ runId: "run", nativeSessionId: contextHeader.id, operationId: "op",
      nativeRevision: events.length, observedAt: "2026-09-14T00:00:00Z",
      payload: { logicalSessionId: "logical-source", instanceId: "fixture", header: contextHeader, inheritedEventCount: 0, events } } as any);
    const projection = { events, header: contextHeader, inheritedEventCount: 0 };
    const latest = v3SessionGraph.completedTurn(canonical.events, projection)!;
    expect(latest.anchorId).toBe("reply-two");
    expect(latest.entries.map(e => e.role)).toEqual(["user", "assistant"]);
    const earlier = v3SessionGraph.completedTurn(canonical.events, projection, latest.cutoffEventId)!;
    expect(earlier.anchorId).toBe("reply-one");
    expect(v3SessionGraph.completedTurn(canonical.events, projection, earlier.cutoffEventId)).toBeUndefined();
    expect(v3SessionGraph.completedTurn(canonical.events, projection, undefined, "reply-one")?.anchorId).toBe("reply-one");
    const incomplete = { ...projection, events: events.slice(0, 11) };
    expect(v3SessionGraph.completedTurn(canonical.events.slice(0, 11), incomplete)?.anchorId).toBe("reply-one");
    expect(v3SessionGraph.completedTurn(canonical.events.slice(0, 11), incomplete, undefined, "reply-two")).toBeUndefined();
  });
});
