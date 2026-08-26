import { describe, expect, it } from "vitest";

import type { NormalizedEvent } from "@linmu/dsh-session-contracts";

import {
  classifyConversationDelta,
  classifyMetadataDelta,
  type SessionMetadata,
} from "../src/index.js";

const event = (id: string, content: string): NormalizedEvent => ({
  id,
  parentId: null,
  sequence: Number(id.slice(1)),
  kind: "message",
  role: "user",
  content,
  attachments: [],
  source: {
    platform: "dsh",
    instanceId: "d",
    sessionId: "s",
    eventId: id,
    sequence: Number(id.slice(1)),
  },
  extensions: {},
});

describe("conversation delta", () => {
  const baseEvents = [event("e0", "a"), event("e1", "b")];

  it("distinguishes unchanged, append-only and rewritten content", () => {
    expect(classifyConversationDelta(baseEvents, structuredClone(baseEvents))).toBe("unchanged");
    expect(classifyConversationDelta(baseEvents, [...baseEvents, event("e2", "c")])).toBe(
      "append-only",
    );
    expect(classifyConversationDelta(baseEvents, [event("e0", "changed"), baseEvents[1]!])).toBe(
      "rewritten",
    );
  });

  it("treats deletion and reordering as rewrites", () => {
    expect(classifyConversationDelta(baseEvents, [baseEvents[0]!])).toBe("rewritten");
    expect(classifyConversationDelta(baseEvents, [...baseEvents].reverse())).toBe("rewritten");
  });
});

describe("metadata delta", () => {
  const base: SessionMetadata = { title: "base", archived: false };

  it("recognizes one-sided changes and convergence", () => {
    expect(classifyMetadataDelta(base, base, base)).toBe("unchanged");
    expect(classifyMetadataDelta(base, { ...base, archived: true }, base)).toBe("source-only");
    expect(classifyMetadataDelta(base, base, { ...base, title: "target" })).toBe("target-only");
    expect(
      classifyMetadataDelta(base, { ...base, title: "same" }, { ...base, title: "same" }),
    ).toBe("unchanged");
  });

  it("marks incompatible dual changes as a metadata conflict", () => {
    expect(
      classifyMetadataDelta(base, { ...base, title: "codex" }, { ...base, title: "dsh" }),
    ).toBe("metadata-conflict");
    expect(
      classifyMetadataDelta(base, { ...base, title: "renamed" }, { ...base, archived: true }),
    ).toBe("metadata-conflict");
  });
});
