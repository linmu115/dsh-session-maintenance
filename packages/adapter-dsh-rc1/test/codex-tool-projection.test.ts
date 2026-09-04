import { describe, expect, it } from "vitest";

import type {
  CanonicalEventV1,
  CanonicalProjectionSessionInput,
  JsonValue,
} from "@linmu/dsh-session-adapter-sdk";

import { assertRc1SessionInvariants } from "../src/inspect.js";
import { rc1NativeSessionId, materializeRc1 } from "../src/materialize.js";

const at = "2026-09-02T00:00:00.000Z";

function event(
  id: string,
  sequence: number,
  kind: CanonicalEventV1["kind"],
  role: CanonicalEventV1["role"],
  content: CanonicalEventV1["content"],
  topology: { readonly turn: number; readonly step: number } = { turn: 0, step: 0 },
): CanonicalEventV1 {
  const phase = kind === "user-message" ? "user"
    : kind === "reasoning" ? "reasoning"
      : kind === "assistant-message" ? "assistant"
        : kind === "tool-call" ? "tool-call"
          : kind === "tool-result" ? "tool-result"
            : null;
  return {
    schemaVersion: 1,
    id,
    logicalSessionId: "ls-codex-tool" as never,
    sequence,
    kind,
    role,
    content,
    source: {
      platform: "codex",
      instanceId: "codex-main",
      sessionId: "thread",
      eventId: id,
      cursor: String(sequence),
    },
    contentDigest: `digest-${id}`,
    rawPayload: null,
    extensions: phase === null ? {} : {
      "mcsf.conversationTopology.v1": {
        schemaVersion: 1,
        turnId: `turn-${topology.turn}`,
        turnOrdinal: topology.turn,
        stepId: `turn-${topology.turn}:step-${topology.step}`,
        stepOrdinal: topology.step,
        phase,
        inference: "explicit",
      },
    },
  };
}

async function project(events: readonly CanonicalEventV1[]) {
  const logicalSessionId = "ls-codex-tool" as never;
  const canonical: CanonicalProjectionSessionInput = {
    session: {
      schemaVersion: 1,
      id: logicalSessionId,
      authorityScope: "maintenance",
      originKind: "codex-mirror",
      headVersionId: null,
      title: "Codex tool projection",
      tags: [],
      archivedAt: null,
      tombstonedAt: null,
      createdAt: at,
      updatedAt: at,
    },
    events,
    workspaceId: null,
  };
  const sessions = new Map<string, JsonValue>();
  await materializeRc1({
    run: {
      schemaVersion: 1,
      id: "run-codex-tool" as never,
      leaseId: "lease-codex-tool" as never,
      branchId: "main" as never,
      instanceId: "rc1",
      profileId: "web",
      dshVersion: "0.1.2-rc.1",
      adapterId: "dsh-rc1",
      state: "preparing",
      startedAt: at,
      heartbeatAt: at,
      checkpointId: null,
    },
    workspaces: [],
    sessions: [canonical],
  }, {
    writeWorkspace: async () => undefined,
    writeSession: async (id, payload) => { sessions.set(id, payload); },
  });
  return sessions.get(rc1NativeSessionId(logicalSessionId)) as {
    readonly events: readonly Array<{
      readonly type: string;
      readonly seq: number;
      readonly data: Record<string, unknown>;
      readonly ignorable?: true;
      readonly sourceEventSeqs?: readonly number[];
      readonly surfaceOp?: unknown;
    }>;
  };
}

function toolCallIds(item: { readonly type: string; readonly data: Record<string, unknown> }): readonly string[] {
  if (item.type !== "assistant/message") return [];
  const message = item.data.message as { readonly content?: readonly Array<Record<string, unknown>> } | undefined;
  return message?.content
    ?.filter((block) => block.type === "tool-call" && typeof block.id === "string")
    .map((block) => block.id as string) ?? [];
}

function toolResultId(item: { readonly type: string; readonly data: Record<string, unknown> }): string | undefined {
  if (item.type !== "tool/result") return undefined;
  const message = item.data.message as { readonly content?: readonly Array<Record<string, unknown>> } | undefined;
  const result = message?.content?.find((block) => block.type === "tool-result");
  return typeof result?.toolCallId === "string" ? result.toolCallId : undefined;
}

function assistantBlocks(item: { readonly type: string; readonly data: Record<string, unknown> }): readonly Record<string, unknown>[] {
  if (item.type !== "assistant/message") return [];
  const message = item.data.message as { readonly content?: readonly Record<string, unknown>[] } | undefined;
  return message?.content ?? [];
}

function assertRc1Lifecycle(events: readonly Array<{
  readonly type: string;
  readonly seq: number;
  readonly data: Record<string, unknown>;
}>): void {
  let nextTurn = 1;
  let nextStep = 1;
  let openTurn: number | null = null;
  let openStep: number | null = null;
  const pendingCalls = new Set<string>();
  for (const [index, item] of events.entries()) {
    expect(item.seq).toBe(index);
    const turn = item.data.turn as number | undefined;
    const step = item.data.step as number | undefined;
    if (item.type === "turn/start") {
      expect(openTurn).toBeNull();
      expect(turn).toBe(nextTurn);
      openTurn = turn!;
      nextStep = 1;
    } else if (item.type === "turn/end") {
      expect(turn).toBe(openTurn);
      expect(openStep).toBeNull();
      openTurn = null;
      nextTurn += 1;
    } else if (item.type === "step/start") {
      expect(turn).toBe(openTurn);
      expect(openStep).toBeNull();
      expect(step).toBe(nextStep);
      openStep = step!;
    } else if (item.type === "step/end") {
      expect(turn).toBe(openTurn);
      expect(step).toBe(openStep);
      pendingCalls.clear();
      openStep = null;
      nextStep += 1;
    } else if (item.type === "assistant/message") {
      expect(turn).toBe(openTurn);
      expect(step).toBe(openStep);
    } else if (item.type === "tool/call") {
      expect(turn).toBe(openTurn);
      expect(step).toBe(openStep);
      pendingCalls.add(item.data.callId as string);
    } else if (item.type === "tool/result") {
      expect(turn).toBe(openTurn);
      expect(step).toBe(openStep);
      const callId = toolResultId(item);
      expect(callId).toBeDefined();
      expect(pendingCalls.has(callId!)).toBe(true);
      pendingCalls.delete(callId!);
    }
  }
  expect(openTurn).toBeNull();
  expect(openStep).toBeNull();
}

describe("Rc1 Codex tool projection", () => {
  it("materializes a request-valid assistant/message -> tool/call -> tool/result chain", async () => {
    const projected = await project([
      event("user-event", 0, "user-message", "user", "run it"),
      event("call-event", 1, "tool-call", "assistant", {
        callId: "call-1",
        name: "exec",
        protocol: "custom",
        arguments: "do work",
      }),
      event("result-event", 2, "tool-result", "tool", {
        callId: "call-1",
        name: "exec",
        protocol: "custom",
        outputText: "done",
      }),
      event("assistant-event", 3, "assistant-message", "assistant", "finished", { turn: 0, step: 1 }),
    ]);

    expect(projected.events.map((item) => item.type)).toEqual([
      "turn/start",
      "user/message",
      "step/start",
      "assistant/message",
      "tool/call",
      "tool/result",
      "step/end",
      "step/start",
      "assistant/message",
      "step/end",
      "turn/end",
    ]);
    expect(toolCallIds(projected.events[3]!)).toEqual(["call-1"]);
    expect(projected.events[4]).toMatchObject({
      seq: 4,
      data: { turn: 1, step: 1, callId: "call-1", name: "exec", arguments: "do work" },
    });
    expect(projected.events[5]).toMatchObject({
      seq: 5,
      sourceEventSeqs: [4],
      surfaceOp: "append",
    });
    assertRc1Lifecycle(projected.events);

    // Mirrors Rc1 Session.deriveMessages(): log-only tool/call is skipped,
    // while assistant/message and tool/result reach the model request.
    const pending = new Set<string>();
    const derived = projected.events.filter((item) =>
      item.type === "user/message" || item.type === "assistant/message" || item.type === "tool/result");
    for (const item of derived) {
      for (const callId of toolCallIds(item)) pending.add(callId);
      const resultId = toolResultId(item);
      if (resultId !== undefined) {
        expect(pending.has(resultId), `orphan tool result ${resultId}`).toBe(true);
        pending.delete(resultId);
      }
    }
    expect([...pending]).toEqual([]);
  });

  it("keeps an unmatched historical tool result off the Rc1 message surface", async () => {
    const projected = await project([
      event("orphan-result", 0, "tool-result", "tool", {
        callId: "missing-call",
        name: "send_message_to_thread",
        protocol: "function",
        outputText: "internal coordination",
      }),
    ]);

    expect(projected.events.map((item) => item.type)).toEqual([
      "turn/start",
      "step/start",
      "maintenance/orphan-tool-result",
      "step/end",
      "turn/end",
    ]);
    expect(projected.events[2]).toEqual(expect.objectContaining({
      type: "maintenance/orphan-tool-result",
      seq: 2,
      ignorable: true,
    }));
    expect(projected.events.some((item) => item.type === "tool/result" || item.surfaceOp !== undefined)).toBe(false);
    assertRc1Lifecycle(projected.events);
  });

  it("projects two Canonical turns, reasoning and parallel calls as native Rc1 lifecycle", async () => {
    const projected = await project([
      event("turn-0-user", 0, "user-message", "user", "inspect"),
      event("turn-0-reasoning", 1, "reasoning", "assistant", "I should inspect two sources."),
      event("turn-0-call-a", 2, "tool-call", "assistant", {
        callId: "call-a", name: "read", protocol: "custom", arguments: "a",
      }),
      event("turn-0-call-b", 3, "tool-call", "assistant", {
        callId: "call-b", name: "read", protocol: "custom", arguments: "b",
      }),
      event("turn-0-result-a", 4, "tool-result", "tool", {
        callId: "call-a", name: "read", protocol: "custom", outputText: "A",
      }),
      event("turn-0-result-b", 5, "tool-result", "tool", {
        callId: "call-b", name: "read", protocol: "custom", outputText: "B",
      }),
      event("turn-0-answer", 6, "assistant-message", "assistant", "first answer", { turn: 0, step: 1 }),
      event("turn-1-user", 7, "user-message", "user", "continue", { turn: 1, step: 0 }),
      event("turn-1-answer", 8, "assistant-message", "assistant", "second answer", { turn: 1, step: 0 }),
    ]);

    assertRc1Lifecycle(projected.events);
    expect(projected.events.filter((item) => item.type === "turn/start").map((item) => item.data.turn))
      .toEqual([1, 2]);
    const firstModelMessage = projected.events.find((item) => item.type === "assistant/message")!;
    expect(assistantBlocks(firstModelMessage).map((block) => block.type)).toEqual([
      "reasoning",
      "tool-call",
      "tool-call",
    ]);
    expect(toolCallIds(firstModelMessage)).toEqual(["call-a", "call-b"]);
    expect(projected.events.filter((item) => item.type === "tool/result")
      .map((item) => toolResultId(item))).toEqual(["call-a", "call-b"]);
    expect(projected.events.filter((item) => item.type === "assistant/message")
      .flatMap((item) => assistantBlocks(item))
      .filter((block) => block.type === "text")
      .map((block) => block.text)).toEqual(["first answer", "second answer"]);
  });

  it("rejects portable conversation rows without the Canonical topology contract", async () => {
    const withoutTopology = event("missing-topology", 0, "user-message", "user", "unsafe");
    await expect(project([{ ...withoutTopology, extensions: {} }]))
      .rejects.toThrow("lacks mcsf.conversationTopology.v1");
  });

  it("rejects an assistant row outside the published RC1 turn/step lifecycle", () => {
    expect(() => assertRc1SessionInvariants([{
      type: "assistant/message",
      seq: 0 as never,
      time: Date.parse(at),
      data: {
        turn: 1,
        step: 1,
        message: { id: "invalid", role: "assistant", content: [], source: { kind: "model" } },
      },
      surfaceOp: "append",
    }])).toThrow("open is turn null/step null");
  });

  it("projects MCSF other evidence as an ignorable tool-style card, never as a model tool result", async () => {
    const other = event("other-event", 0, "other", "unknown", {
      schemaVersion: 1,
      type: "other",
      reason: "no-common-semantics",
      sourceKind: "codex/unsupported_fixture_event",
      label: "未映射的 Codex 记录",
      summary: "只供用户查阅",
      evidenceRef: "sha256:fixture-evidence",
    });
    const projected = await project([{ ...other, rawPayload: {
      type: "user/message",
      seq: 99,
      time: 123,
      data: { id: "must-not-replay", role: "user", content: [{ type: "text", text: "leak" }] },
      surfaceOp: "append",
    } }]);

    expect(projected.events).toEqual([expect.objectContaining({
      type: "maintenance/other",
      seq: 0,
      ignorable: true,
      data: expect.objectContaining({
        presentation: "tool-card",
        modelExposure: "log-only",
      }),
    })]);
    expect(projected.events.some((item) => item.type === "tool/result" || item.surfaceOp !== undefined)).toBe(false);
    expect(JSON.stringify(projected.events)).not.toContain("must-not-replay");
  });

  it("aggregates genuine unknown rows into at most one folded record per turn or outside region", async () => {
    const other = (id: string, sequence: number, sourceKind: string) => event(
      id,
      sequence,
      "other",
      "unknown",
      {
        schemaVersion: 1,
        type: "other",
        reason: "unsupported-source-event",
        sourceKind,
        label: "未映射的 Codex 记录",
        summary: `${sourceKind} 只作为证据保留`,
        evidenceRef: `evidence:${id}`,
      },
    );
    const projected = await project([
      event("group-user", 0, "user-message", "user", "question"),
      other("unknown-a", 1, "codex/unknown-a"),
      event("group-reasoning", 2, "reasoning", "assistant", "thinking"),
      other("unknown-b", 3, "codex/unknown-b"),
      event("group-answer", 4, "assistant-message", "assistant", "answer"),
      event("group-user-two", 5, "user-message", "user", "next", { turn: 1, step: 0 }),
      event("group-answer-two", 6, "assistant-message", "assistant", "next answer", { turn: 1, step: 0 }),
      other("unknown-c", 7, "codex/unknown-c"),
      other("unknown-d", 8, "codex/unknown-d"),
    ]);

    const cards = projected.events.filter((item) => item.type === "maintenance/other");
    expect(cards).toHaveLength(2);
    expect(cards.map((item) => item.data)).toEqual([
      expect.objectContaining({
        collapsed: true,
        modelExposure: "log-only",
        grouping: expect.objectContaining({ count: 2, firstCanonicalSequence: 1, lastCanonicalSequence: 3 }),
      }),
      expect.objectContaining({
        collapsed: true,
        modelExposure: "log-only",
        grouping: expect.objectContaining({ count: 2, firstCanonicalSequence: 7, lastCanonicalSequence: 8 }),
      }),
    ]);
    expect(cards.every((item) => item.ignorable === true && item.surfaceOp === undefined)).toBe(true);
    assertRc1Lifecycle(projected.events);
  });

  it("rebases a sparse derived-session history without changing tool correlation", async () => {
    const projected = await project([
      event("base-user", 17_740, "user-message", "user", "continue"),
      event("base-call", 17_741, "tool-call", "assistant", {
        callId: "call-sparse",
        name: "exec",
        protocol: "custom",
        arguments: "inspect",
      }),
      event("derived-result", 20_501, "tool-result", "tool", {
        callId: "call-sparse",
        name: "exec",
        protocol: "custom",
        outputText: "done",
      }),
      event("derived-answer", 20_502, "assistant-message", "assistant", "finished", { turn: 0, step: 1 }),
    ]);

    expect(projected.events.map((item) => item.seq)).toEqual([...Array(11).keys()]);
    expect(toolCallIds(projected.events[3]!)).toEqual(["call-sparse"]);
    expect(projected.events[5]).toMatchObject({
      type: "tool/result",
      sourceEventSeqs: [4],
    });
    expect(toolResultId(projected.events[5]!)).toBe("call-sparse");
    assertRc1Lifecycle(projected.events);
  });
});
