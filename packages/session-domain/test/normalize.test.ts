import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  normalizeSession,
  sha256Canonical,
  type NormalizationInput,
} from "../src/index.js";

const base: NormalizationInput = {
  key: { platform: "codex", instanceId: "codex-fixture", sessionId: "thread-1" },
  title: "first",
  archived: false,
  workspaceId: "workspace-a",
  provenance: {
    platform: "codex",
    instanceId: "codex-fixture",
    sessionId: "thread-1",
    observedAt: "2026-08-26T00:00:00.000Z",
  },
  compatibility: { status: "compatible", issues: [] },
  events: [
    {
      sourceEventId: "u1",
      parentSourceEventId: null,
      sequence: 0,
      kind: "message",
      role: "user",
      content: "hello 世界 👋",
      attachments: [],
      extensions: { source: { format: "fixture", revision: 1 } },
    },
  ],
};

describe("canonical JSON", () => {
  it("sorts object keys recursively and preserves array order", () => {
    const left = { z: 1, nested: { b: "世界", a: true }, items: ["a", "b"] };
    const right = { items: ["a", "b"], nested: { a: true, b: "世界" }, z: 1 };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(sha256Canonical(left)).toBe(sha256Canonical(right));
    expect(canonicalJson({ items: ["a", "b"] })).not.toBe(
      canonicalJson({ items: ["b", "a"] }),
    );
  });

  it("rejects non-JSON and cyclic values", () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/finite/u);
    expect(() => canonicalJson({ value: undefined } as never)).toThrow(/undefined/u);
    expect(() => canonicalJson({ value: () => undefined } as never)).toThrow(/function/u);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic as never)).toThrow(/cyclic/u);
  });
});

describe("session normalization", () => {
  it("excludes observation-only fields and separates metadata identity", () => {
    const later = "2026-08-27T00:00:00.000Z";
    const first = normalizeSession({
      ...base,
      observedPath: "X:\\fixture-a",
      observedPid: 100,
      observedPort: 41000,
      logLocation: "X:\\logs\\a.log",
    });
    const observedElsewhere = normalizeSession({
      ...base,
      observedPath: "Y:\\fixture-b",
      observedPid: 200,
      observedPort: 42000,
      logLocation: "Y:\\logs\\b.log",
      provenance: { ...base.provenance, observedAt: later },
    });
    const renamed = normalizeSession({ ...base, title: "new" });
    const archived = normalizeSession({ ...base, archived: true });

    expect(first.bodyHash).toBe(observedElsewhere.bodyHash);
    expect(first.metadataHash).toBe(observedElsewhere.metadataHash);
    expect(renamed.bodyHash).toBe(first.bodyHash);
    expect(renamed.metadataHash).not.toBe(first.metadataHash);
    expect(archived.bodyHash).toBe(first.bodyHash);
    expect(archived.metadataHash).not.toBe(first.metadataHash);
  });

  it("preserves attachment order and changes identity for semantic edits", () => {
    const attachments = [
      { name: "a.txt", mediaType: "text/plain", source: "fixture:a" },
      { name: "b.txt", mediaType: "text/plain", source: "fixture:b" },
    ];
    const withAttachments = normalizeSession({
      ...base,
      events: [{ ...base.events[0]!, attachments }],
    });
    const reordered = normalizeSession({
      ...base,
      events: [{ ...base.events[0]!, attachments: [...attachments].reverse() }],
    });
    const edited = normalizeSession({
      ...base,
      events: [{ ...base.events[0]!, content: "changed" }],
    });

    expect(reordered.bodyHash).not.toBe(withAttachments.bodyHash);
    expect(edited.bodyHash).not.toBe(withAttachments.bodyHash);
    expect(edited.events[0]?.id).not.toBe(withAttachments.events[0]?.id);
  });

  it("uses stable normalized parent IDs and workspace identity", () => {
    const conversation = normalizeSession({
      ...base,
      events: [
        base.events[0]!,
        {
          ...base.events[0]!,
          sourceEventId: "a1",
          parentSourceEventId: "u1",
          sequence: 1,
          role: "assistant",
          content: "answer",
        },
      ],
    });
    const otherWorkspace = normalizeSession({ ...base, workspaceId: "workspace-b" });

    expect(conversation.events[1]?.parentId).toBe(conversation.events[0]?.id);
    expect(conversation.events[0]?.id).toMatch(/^ev_[0-9a-f]{24}$/u);
    expect(otherWorkspace.bodyHash).not.toBe(normalizeSession(base).bodyHash);
  });
});
