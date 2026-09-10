import { describe, expect, it } from "vitest";
import type {
  CanonicalEventV1,
  JsonValue,
  ProjectionReader,
  ProjectionRun,
} from "@linmu/dsh-session-adapter-sdk";

import { assertRc1SessionInvariants } from "../src/inspect.js";
import { materializeRc1, rc1NativeSessionId, type Rc1ProjectionSession } from "../src/materialize.js";
import { portableizeRc1CanonicalHistory } from "../src/normalize-append.js";
import { resolveRc1Reference } from "../src/references.js";
import { adapter } from "../src/index.js";

const at = "2026-09-05T00:00:00.000Z";
const logicalSessionId = "logical-synthetic-message-anchors" as never;
const nativeSessionId = rc1NativeSessionId(logicalSessionId);
const run: ProjectionRun = {
  schemaVersion: 1,
  id: "run-synthetic-message-anchors" as never,
  leaseId: "lease-synthetic" as never,
  branchId: "main" as never,
  instanceId: "rc1-synthetic",
  profileId: "synthetic",
  dshVersion: "0.1.2-rc.1",
  adapterId: "dsh-rc1" as never,
  state: "preparing",
  startedAt: at,
  heartbeatAt: at,
  checkpointId: null,
};

function event(
  id: string,
  sequence: number,
  kind: CanonicalEventV1["kind"],
  content: JsonValue,
  step = 0,
): CanonicalEventV1 {
  const phase = kind === "user-message" ? "user" : kind === "assistant-message" ? "assistant"
    : kind === "reasoning" ? "reasoning" : kind === "tool-call" ? "tool-call"
      : kind === "tool-result" ? "tool-result" : null;
  return {
    schemaVersion: 1,
    id,
    logicalSessionId,
    sequence,
    kind,
    role: kind === "user-message" ? "user" : kind === "tool-result" ? "tool" : "assistant",
    content,
    source: { platform: "dsh", instanceId: "synthetic", sessionId: "synthetic-native", eventId: id, cursor: String(sequence) },
    contentDigest: `synthetic-digest:${id}`,
    rawPayload: null,
    extensions: phase === null ? {} : {
      "mcsf.conversationTopology.v1": {
        schemaVersion: 1,
        turnId: "turn-0",
        turnOrdinal: 0,
        stepId: `step-${step}`,
        stepOrdinal: step,
        phase,
        inference: "explicit",
      },
    },
  };
}

function message(id: JsonValue, role: "user" | "assistant"): JsonValue {
  return {
    id,
    role,
    content: [{ type: "text", text: `synthetic ${role}` }],
    source: role === "user" ? { kind: "user" } : { kind: "model", provider: "deepseek", model: "synthetic" },
  };
}

function nativeHistory(userId: JsonValue = "native-user", assistantId: JsonValue = "native-assistant") {
  const rawEvents = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "user/message", data: message(userId, "user"), surfaceOp: "append" },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "assistant/message", data: { turn: 1, step: 1, message: message(assistantId, "assistant") }, surfaceOp: "append" },
    { type: "step/end", data: { turn: 1, step: 1 } },
    { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
  ];
  return rawEvents.map((raw, sequence): CanonicalEventV1 => ({
    ...event(`native-event-${sequence}`, sequence,
      raw.type === "user/message" ? "user-message" : raw.type === "assistant/message" ? "assistant-message" : "opaque-unknown",
      raw.data as JsonValue),
    rawPayload: { ...raw, seq: sequence, time: Date.parse(at) + sequence } as JsonValue,
  }));
}

function portableHistory(native: readonly CanonicalEventV1[]) {
  return portableizeRc1CanonicalHistory(native).map((item) => ({
    ...item,
    extensions: event(item.id, item.sequence, item.kind, item.content).extensions,
  }));
}

async function project(events: readonly CanonicalEventV1[]) {
  let payload: Rc1ProjectionSession | undefined;
  await materializeRc1({
    run,
    workspaces: [],
    sessions: [{
      session: {
        schemaVersion: 1,
        id: logicalSessionId,
        authorityScope: "maintenance",
        originKind: "native",
        headVersionId: null,
        title: "Synthetic message anchors",
        tags: [],
        archivedAt: null,
        tombstonedAt: null,
        createdAt: at,
        updatedAt: at,
      },
      events,
      workspaceId: null,
    }],
  }, {
    writeWorkspace: async () => undefined,
    writeSession: async (_id, value) => { payload = value as unknown as Rc1ProjectionSession; },
  });
  return payload!;
}

function reader(payload: Rc1ProjectionSession): ProjectionReader {
  return {
    listNativeSessionIds: async () => [nativeSessionId],
    readSession: async (id) => {
      expect(id).toBe(nativeSessionId);
      return payload as unknown as JsonValue;
    },
  };
}

function surfaceIds(payload: Rc1ProjectionSession): string[] {
  return payload.events.filter((item) => item.surfaceOp === "append").map((item) => {
    const data = item.data as { id?: string; message?: { id: string } };
    return item.type === "user/message" ? data.id! : data.message!.id;
  });
}

async function resolve(anchor: string | null, payload?: Rc1ProjectionSession) {
  return resolveRc1Reference({ logicalSessionId, logicalAnchorId: anchor, legacyNativeSessionId: null }, run,
    payload === undefined ? undefined : reader(payload));
}

describe("Rc1 historical message anchors", () => {
  it("retains real native user and single-assistant message IDs through portable re-projection", async () => {
    const native = nativeHistory();
    const original = await project(native);
    expect(surfaceIds(original)).toEqual(["native-user", "native-assistant"]);
    const portable = portableHistory(native);
    expect(portable.map((item) => item.id)).toEqual(["native-event-1", "native-event-3"]);
    const projected = await project(portable);
    assertRc1SessionInvariants(projected.events);
    expect(surfaceIds(projected)).toEqual(surfaceIds(original));
    expect(projected.anchorAliases).toMatchObject({
      "native-event-1": "native-user",
      "native-event-3": "native-assistant",
    });
    for (const anchor of ["native-user", "native-event-1", "native-assistant", "native-event-3"]) {
      expect(await resolve(anchor, projected)).toMatchObject({
        nativeAnchorId: anchor.includes("user") || anchor.endsWith("1") ? "native-user" : "native-assistant",
        status: "resolved",
      });
    }
    expect(JSON.stringify(projected.events)).not.toContain("anchorAliases");
  });

  it.each(["", "   ", null, 42])("falls back from invalid embedded IDs (%j) to distinct canonical identities", async (id) => {
    const projected = await project(portableHistory(nativeHistory(id, id)));
    expect(surfaceIds(projected)).toEqual(["native-event-1", "native-event-3"]);
    expect(new Set(surfaceIds(projected)).size).toBe(2);
  });

  it("rejects duplicate historical message IDs instead of renaming or making ambiguous anchors", async () => {
    await expect(project(portableHistory(nativeHistory("duplicate", "duplicate"))))
      .rejects.toThrow("repeats message ID duplicate");
  });

  it("rejects collisions between a preserved message ID and another canonical anchor", async () => {
    await expect(project(portableHistory(nativeHistory("native-event-3", "native-assistant"))))
      .rejects.toThrow("ambiguous message anchor native-event-3");
  });

  it("keeps multi-source reasoning/tool aggregation and aliases every contributing source to its real message", async () => {
    const projected = await project([
      event("question", 0, "user-message", message("native-question", "user")),
      event("thought", 1, "reasoning", "synthetic thought"),
      event("answer", 2, "assistant-message", message("native-answer", "assistant")),
      event("call-event", 3, "tool-call", { callId: "native-call-id", name: "read", arguments: "{}", protocol: "dsh" }),
      event("result-event", 4, "tool-result", { callId: "native-call-id", outputText: "synthetic result" }),
      event("retired-other", 5, "other", { sourceKind: "synthetic/unknown", summary: "synthetic evidence" }),
    ]);
    assertRc1SessionInvariants(projected.events);
    const aggregatedId = "mcsf:turn-0:step-0:assistant";
    expect(surfaceIds(projected)).toEqual(["native-question", aggregatedId, "result-event"]);
    for (const anchor of ["thought", "answer", "native-answer", "call-event"]) {
      expect(projected.anchorAliases?.[anchor]).toBe(aggregatedId);
      expect(await resolve(anchor, projected)).toMatchObject({ nativeAnchorId: aggregatedId, status: "resolved" });
    }
    const call = projected.events.find((item) => item.type === "tool/call")!;
    expect(call.data).toMatchObject({ callId: "native-call-id" });
    expect(projected.events.find((item) => item.type === "tool/result")?.sourceEventSeqs).toEqual([call.seq]);
    expect(projected.anchorAliases?.["retired-other"]).toBeUndefined();
    expect(await resolve("retired-other", projected)).toMatchObject({ status: "unavailable" });
    expect(await resolve("native-call-id", projected)).toMatchObject({ status: "unavailable" });
  });

  it("maps multiple assistant messages in one step without replacing the aggregate with one source ID", async () => {
    const projected = await project([
      event("answer-a", 0, "assistant-message", message("native-a", "assistant")),
      event("answer-b", 1, "assistant-message", message("native-b", "assistant")),
    ]);
    expect(surfaceIds(projected)).toEqual(["mcsf:turn-0:step-0:assistant"]);
    for (const anchor of ["answer-a", "answer-b", "native-a", "native-b"]) {
      expect(await resolve(anchor, projected)).toMatchObject({ nativeAnchorId: "mcsf:turn-0:step-0:assistant", status: "resolved" });
    }
  });

  it("requires a reader for message anchors while retaining the no-reader session-only contract", async () => {
    expect(await resolve(null)).toMatchObject({ nativeSessionId, nativeAnchorId: null, status: "resolved" });
    expect(await resolve("native-assistant")).toMatchObject({ nativeSessionId: null, nativeAnchorId: null, status: "unavailable" });
  });

  it("verifies original message IDs in legacy native payloads without an alias map", async () => {
    const projected = await project(nativeHistory());
    expect(projected.anchorAliases).toBeUndefined();
    expect(await resolve("native-assistant", projected)).toMatchObject({ nativeAnchorId: "native-assistant", status: "resolved" });
    expect(await resolve("unknown", projected)).toMatchObject({ status: "unavailable" });
  });

  it("uses the current mapped native ID for a derived session while checking its logical identity", async () => {
    const projected = await project(portableHistory(nativeHistory()));
    const mappedNativeId = "synthetic-inherited-parent-native" as never;
    const payload = { ...projected, header: { ...projected.header, id: mappedNativeId } };
    const mappedReader: ProjectionReader = {
      listNativeSessionIds: async () => [mappedNativeId],
      readSession: async (id) => {
        expect(id).toBe(mappedNativeId);
        return payload as unknown as JsonValue;
      },
    };
    expect(await adapter.resolveReference({ logicalSessionId, logicalAnchorId: "native-event-3", legacyNativeSessionId: mappedNativeId }, run, mappedReader))
      .toMatchObject({ nativeSessionId: mappedNativeId, nativeAnchorId: "native-assistant", status: "resolved" });
    expect(adapter.manifest.capabilities).toContain("verified-anchor-resolution");
    // The version is part of projection cache fingerprints; old payloads must
    // not be reused after message identities and alias metadata change.
    expect(adapter.manifest.packageVersion).toBe("0.1.5");
  });

  it("rejects stale aliases, duplicate targets, missing sessions, and mismatched payload identities", async () => {
    const projected = await project(portableHistory(nativeHistory()));
    expect(await resolve("stale", { ...projected, anchorAliases: { stale: "missing-message" } }))
      .toMatchObject({ status: "unavailable" });
    expect(await resolve("native-user", { ...projected, anchorAliases: { "native-user": "native-assistant" } }))
      .toMatchObject({ status: "unavailable" });
    expect(await resolve("native-user", { ...projected, events: [...projected.events, projected.events.find((item) => item.type === "user/message")!] }))
      .toMatchObject({ status: "unavailable" });
    expect(await resolve("native-user", { ...projected, logicalSessionId: "wrong" as never }))
      .toMatchObject({ status: "unavailable" });
    expect(await resolve("native-user", { ...projected, header: { ...projected.header, id: "wrong" as never } }))
      .toMatchObject({ status: "unavailable" });
    expect(await resolve("   ", projected)).toMatchObject({ status: "unavailable" });
    expect(await resolveRc1Reference({ logicalSessionId, logicalAnchorId: "native-user", legacyNativeSessionId: null }, run, {
      listNativeSessionIds: async () => [],
      readSession: async () => { throw new Error("synthetic missing session"); },
    })).toMatchObject({ status: "unavailable" });
  });
});
