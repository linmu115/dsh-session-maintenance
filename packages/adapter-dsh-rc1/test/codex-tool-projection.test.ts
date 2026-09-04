import { describe, expect, it } from "vitest";

import type {
  CanonicalEventV1,
  CanonicalProjectionSessionInput,
  JsonValue,
} from "@linmu/dsh-session-adapter-sdk";

import { rc1NativeSessionId, materializeRc1 } from "../src/materialize.js";

const at = "2026-09-02T00:00:00.000Z";

function event(
  id: string,
  sequence: number,
  kind: CanonicalEventV1["kind"],
  role: CanonicalEventV1["role"],
  content: CanonicalEventV1["content"],
): CanonicalEventV1 {
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
    extensions: {},
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
      event("assistant-event", 3, "assistant-message", "assistant", "finished"),
    ]);

    expect(projected.events.map((item) => item.type)).toEqual([
      "user/message",
      "assistant/message",
      "tool/call",
      "tool/result",
      "assistant/message",
    ]);
    expect(toolCallIds(projected.events[1]!)).toEqual(["call-1"]);
    expect(projected.events[2]).toMatchObject({
      seq: 2,
      data: { callId: "call-1", name: "exec", arguments: "do work" },
    });
    expect(projected.events[3]).toMatchObject({
      seq: 3,
      sourceEventSeqs: [2],
      surfaceOp: "append",
    });

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

    expect(projected.events).toEqual([expect.objectContaining({
      type: "maintenance/orphan-tool-result",
      seq: 0,
      ignorable: true,
    })]);
    expect(projected.events.some((item) => item.type === "tool/result" || item.surfaceOp !== undefined)).toBe(false);
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
      event("derived-answer", 20_502, "assistant-message", "assistant", "finished"),
    ]);

    expect(projected.events.map((item) => item.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(toolCallIds(projected.events[1]!)).toEqual(["call-sparse"]);
    expect(projected.events[3]).toMatchObject({
      type: "tool/result",
      sourceEventSeqs: [2],
    });
    expect(toolResultId(projected.events[3]!)).toBe("call-sparse");
  });
});
