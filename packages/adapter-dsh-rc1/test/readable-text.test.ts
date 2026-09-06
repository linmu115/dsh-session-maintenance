import { describe, expect, it } from "vitest";
import type { CanonicalEventV1, JsonValue, NativeAppendOperation } from "@linmu/dsh-session-adapter-sdk";
import { normalizeRc1Append } from "../src/normalize-append.js";
import { readRc1CanonicalEventText } from "../src/readable-text.js";

const at = "2026-09-05T00:00:00.000Z";
function event(content: JsonValue): CanonicalEventV1 {
  return { schemaVersion: 1, id: "readable-fixture", logicalSessionId: "logical-synthetic" as never,
    sequence: 1, kind: "assistant-message", role: "assistant", content, contentDigest: "sha256:synthetic",
    source: { platform: "dsh", instanceId: "synthetic", sessionId: "native-synthetic", eventId: null, cursor: null }, rawPayload: null, extensions: {},
  };
}
const payload = { turn: 1, step: 1, message: {
  id: "assistant-1", role: "assistant", content: [{ type: "text", text: "hello" }],
  source: { kind: "model", provider: "test", model: "test", text: "source evidence" },
}, metadata: { text: "metadata evidence" } };

describe("read-only DSH canonical event presentation", () => {
  it("reads the real native assistant envelope without rewriting normalized content or evidence", async () => {
    const operation = { runId: "synthetic-run", operationId: "synthetic-operation", nativeSessionId: "synthetic-native",
      nativeRevision: 1, observedAt: at, payload: { logicalSessionId: "logical-synthetic", canonicalHistoryMode: "native",
        events: [{ type: "assistant/message", seq: 0, time: Date.parse(at), data: payload, surfaceOp: "append" }],
      },
    } as unknown as NativeAppendOperation;
    const { events } = await normalizeRc1Append(operation);
    const before = JSON.stringify(events);
    expect(events[0]?.content).toEqual(payload);
    expect(readRc1CanonicalEventText(events[0]!)).toBe("hello");
    expect(JSON.stringify(events)).toBe(before);
  });

  it("never searches nested wrappers, metadata, source or unknown event kinds", () => {
    expect(readRc1CanonicalEventText(event({ metadata: payload, source: payload }))).toBeNull();
    expect(readRc1CanonicalEventText(event({ content: [payload] }))).toBeNull();
    expect(readRc1CanonicalEventText(event({ message: payload.message }))).toBeNull();
    expect(readRc1CanonicalEventText(event({ ...payload, message: { ...payload.message, role: "tool" } }))).toBeNull();
    expect(readRc1CanonicalEventText({ ...event(payload), kind: "other" })).toBeNull();
    expect(readRc1CanonicalEventText({ ...event(payload), source: { ...event(payload).source, platform: "codex" } })).toBeNull();
  });

  it("keeps supported plain and portable message blocks readable while excluding tool blocks", () => {
    expect(readRc1CanonicalEventText(event("plain"))).toBe("plain");
    expect(readRc1CanonicalEventText(event({ text: "text field" }))).toBe("text field");
    expect(readRc1CanonicalEventText(event({ content: [{ type: "text", text: "visible" }, { type: "tool-call", text: "hidden tool" }] }))).toBe("visible");
  });
});
