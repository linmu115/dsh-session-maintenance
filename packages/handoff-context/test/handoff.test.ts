import { describe, expect, it } from "vitest";

import type { NormalizedSession, SessionVersionManifest } from "@linmu/dsh-session-contracts";

import { HandoffBuilder, HandoffError } from "../src/index.js";

function source(
  id: string,
  events: NormalizedSession["events"],
): { readonly manifest: SessionVersionManifest; readonly session: NormalizedSession } {
  const key = { platform: "dsh" as const, instanceId: "dsh-fixture", sessionId: `session-${id}` };
  return {
    manifest: {
      schemaVersion: 1,
      id,
      logicalSessionId: "logical-1",
      parents: [],
      bodyObject: `object-${id}`,
      bodyHash: `body-${id}`,
      metadataHash: `meta-${id}`,
      source: { ...key, observedAt: "2026-08-27T00:00:00.000Z" },
      compatibility: { status: "compatible", issues: [] },
    },
    session: {
      schemaVersion: 1,
      key,
      title: "DSH source",
      archived: false,
      workspaceId: "workspace-1",
      events,
      bodyHash: `body-${id}`,
      metadataHash: `meta-${id}`,
      provenance: { ...key, observedAt: "2026-08-27T00:00:00.000Z" },
      compatibility: { status: "compatible", issues: [] },
    },
  };
}

function event(input: {
  readonly id: string;
  readonly sequence: number;
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
  readonly kind?: "message" | "tool-import";
}): NormalizedSession["events"][number] {
  return {
    id: input.id,
    parentId: null,
    sequence: input.sequence,
    kind: input.kind ?? "message",
    role: input.role,
    content: input.content,
    attachments: [],
    source: {
      platform: "dsh",
      instanceId: "dsh-fixture",
      sessionId: "session-source",
      eventId: input.id,
      sequence: input.sequence,
    },
    extensions: {},
  };
}

describe("handoff context", () => {
  it("builds budgeted, traceable full/checkpoint/summary and two-parent bundles", () => {
    const builder = new HandoffBuilder();
    const primary = source("version-a", [
      event({ id: "u1", sequence: 0, role: "user", content: "first question" }),
      event({ id: "t1", sequence: 1, role: "tool", kind: "tool-import", content: "historical tool output" }),
      event({ id: "a1", sequence: 2, role: "assistant", content: "answer" }),
    ]);

    const full = builder.build({ sources: [primary], mode: "full", tokenBudget: 4_000 });
    expect(full.prompt).toContain("source-event: dsh/dsh-fixture/session-source/u1#0");
    expect(full.prompt).toContain("DSH IMPORT RECORD (not a Codex tool execution)");
    expect(full.archiveObjectIds).toEqual(["object-version-a"]);
    expect(full.omissions).toEqual([]);

    const checkpoint = builder.build({
      sources: [primary],
      mode: "checkpoint",
      checkpointStartSequence: 2,
      tokenBudget: 4_000,
    });
    expect(checkpoint.prompt).not.toContain("first question");
    expect(checkpoint.prompt).toContain("answer");
    expect(checkpoint.omissions[0]).toMatchObject({ reason: "checkpoint", eventCount: 2 });

    const oversized = source("version-large", Array.from({ length: 20 }, (_, index) =>
      event({ id: `u${index}`, sequence: index, role: "user", content: "x".repeat(300) }),
    ));
    const preview = builder.preview({ sources: [oversized], mode: "full", tokenBudget: 300 });
    expect(preview.allowed).toBe(false);
    expect(() => builder.build({ sources: [oversized], mode: "full", tokenBudget: 300 }))
      .toThrowError(HandoffError);
    const summary = builder.build({ sources: [oversized], mode: "structured-summary", tokenBudget: 1_000 });
    expect(summary.omissions.some((item) => item.reason === "structured-summary")).toBe(true);
    expect(summary.prompt).toContain("Full immutable archive: object-version-large");

    const secondary = source("version-b", [
      event({ id: "u2", sequence: 0, role: "user", content: "other branch" }),
    ]);
    const resolution = builder.build({
      sources: [primary, secondary],
      mode: "full",
      tokenBudget: 4_000,
      resolution: { commonAncestorVersionId: "base", mergeNote: "Keep both alternatives" },
    });
    expect(resolution.prompt).toContain("Branch 1 of 2: version-a");
    expect(resolution.prompt).toContain("Branch 2 of 2: version-b");
    expect(resolution.prompt).toContain("Keep both alternatives");
    expect(resolution.sourceVersionIds).toEqual(["version-a", "version-b"]);
  });
});
