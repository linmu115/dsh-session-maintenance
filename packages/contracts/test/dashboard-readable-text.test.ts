import { describe, expect, it } from "vitest";
import { canonicalDashboardEventSchema, canonicalEventV1Schema } from "../src/schemas.js";

const event = { schemaVersion: 1, id: "synthetic-event", logicalSessionId: "synthetic-session", sequence: 0,
  kind: "assistant-message", role: "assistant", content: { opaque: "saved payload" },
  source: { platform: "dsh", instanceId: "synthetic", sessionId: "synthetic-native", eventId: null, cursor: null },
  contentDigest: "sha256:synthetic", rawPayload: null, extensions: {},
};

describe("query-only canonical readable text", () => {
  it("accepts readable text without adding it to the persisted event contract", () => {
    expect(canonicalDashboardEventSchema.parse({ ...event, readableText: "hello" }).readableText).toBe("hello");
    expect(canonicalDashboardEventSchema.parse(event).readableText).toBeUndefined();
    expect(canonicalEventV1Schema.safeParse({ ...event, readableText: "hello" }).success).toBe(false);
    expect(canonicalDashboardEventSchema.safeParse({ ...event, readableText: 42 }).success).toBe(false);
  });

  it("preserves canonical event refinements in the response schema", () => {
    const invalidOther = { ...event, kind: "other", role: "assistant", readableText: "must not hide an invalid record" };
    expect(canonicalDashboardEventSchema.safeParse(invalidOther).success).toBe(false);
  });
});
