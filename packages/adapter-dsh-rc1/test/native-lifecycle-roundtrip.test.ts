import { describe, expect, it } from "vitest";
import type { CanonicalProjectionInput, JsonValue, NativeAppendOperation } from "@linmu/dsh-session-adapter-sdk";
import { assertRc1SessionInvariants, inspectRc1, materializeRc1, normalizeRc1Append } from "../src/index.js";
import type { Rc1ProjectionSession } from "../src/materialize.js";
import { restoreAlpha2LifecycleEvidence } from "../../adapter-dsh-alpha2/src/restore-lifecycle-evidence.js";

const at = "2026-09-05T00:00:00.000Z";
const raw = [
  { type: "turn/start", data: { turn: 1 } },
  { type: "step/start", data: { turn: 1, step: 1 } },
  { type: "user/message", data: { id: "user-1", role: "user", content: [{ type: "text", text: "hello" }], source: { kind: "user" } }, surfaceOp: "append" },
  { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "hello" } } },
  { type: "assistant/message", data: { turn: 1, step: 1, message: { id: "assistant-1", role: "assistant", content: [{ type: "text", text: "hello" }], source: { kind: "model", provider: "test", model: "test" } } }, surfaceOp: "append" },
  { type: "step/end", data: { turn: 1, step: 1 } },
  { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
].map((event, seq) => ({ ...event, seq, time: Date.parse(at) + seq })) as JsonValue[];

function operation(events = raw): NativeAppendOperation {
  return { runId: "synthetic-run", operationId: "synthetic-operation", nativeSessionId: "synthetic-native",
    nativeRevision: events.length, observedAt: at,
    payload: { logicalSessionId: "synthetic-logical", canonicalHistoryMode: "native", events },
  } as unknown as NativeAppendOperation;
}

async function project(events: Awaited<ReturnType<typeof normalizeRc1Append>>["events"]) {
  let payload!: Rc1ProjectionSession;
  await materializeRc1({ run: { id: "synthetic-run" }, workspaces: [], sessions: [{
    session: { id: "synthetic-logical", headVersionId: "version-synthetic", createdAt: at, updatedAt: at, title: "synthetic", tags: [] },
    events, workspaceId: null, projectRoot: null,
  }] } as unknown as CanonicalProjectionInput, {
    writeWorkspace: async () => {}, writeSession: async (_id, value) => { payload = value as unknown as Rc1ProjectionSession; },
  });
  return payload;
}

describe("native lifecycle persistence across restarts", () => {
  it("keeps native controls across append, materialize and a second append roundtrip", async () => {
    const normalized = await normalizeRc1Append(operation());
    expect(normalized.events.filter((event) => event.kind === "system-metadata")).toHaveLength(4);
    expect(normalized.events.some((event) => event.kind === "other")).toBe(false);
    const payload = await project(normalized.events);
    expect(() => assertRc1SessionInvariants(payload.events)).not.toThrow();
    const reloaded = await project((await normalizeRc1Append(operation(payload.events as unknown as JsonValue[]))).events);
    expect(reloaded.events).toEqual(payload.events);
    expect(reloaded.events).toEqual(raw);
  });

  it("keeps portable control events evidence-only and unknown native events isolated", async () => {
    const portable = operation();
    const normalized = await normalizeRc1Append({ ...portable, payload: { ...(portable.payload as object), canonicalHistoryMode: "portable" } } as NativeAppendOperation);
    expect(normalized.events.map((event) => event.kind)).toEqual(["user-message", "assistant-message"]);
    const unknown = await normalizeRc1Append(operation([{ type: "future/private", seq: 0, time: 0, data: { secret: "not-model-text" } }]));
    expect(unknown.events[0]).toMatchObject({ kind: "other", rawPayload: null });
    expect(JSON.stringify(unknown.events)).not.toContain("not-model-text");
  });

  it("restores only exact historical Alpha2 boundary evidence without changing IDs or conversation content", async () => {
    const native = await normalizeRc1Append(operation());
    const historical = native.events.map((event) => event.kind !== "system-metadata" ? event : ({ ...event,
      kind: "other" as const, rawPayload: null, content: { sourceKind: `dsh-alpha2/${event.extensions.dshEventType}`, evidenceRef: `ref-${event.sequence}` },
      extensions: { ...event.extensions, heldOut: true },
    }));
    const before = JSON.stringify(historical);
    const reader = { readEvidence: async (ref: string) => ({ schemaVersion: 1, adapterId: "dsh-alpha2",
      nativeFormatId: "dsh/0.1.2-alpha.2/session-event-v1", sourceKind: `dsh-alpha2/${(raw[Number(ref.slice(4))] as {type:string}).type}`,
      payload: raw[Number(ref.slice(4))], observedAt: at,
    }) as never };
    const restored = await restoreAlpha2LifecycleEvidence(historical, reader);
    expect(JSON.stringify(historical)).toBe(before);
    expect(restored.map((event) => event.id)).toEqual(historical.map((event) => event.id));
    expect(restored[2]).toBe(historical[2]);
    expect(restored[4]).toBe(historical[4]);
    const payload = await project(restored);
    expect(payload.events).toEqual(raw);
    expect(() => assertRc1SessionInvariants(payload.events)).not.toThrow();
    await expect(restoreAlpha2LifecycleEvidence(historical, { readEvidence: async () => undefined })).rejects.toThrow("does not match");
    await expect(restoreAlpha2LifecycleEvidence(historical, { readEvidence: async (ref) => ({ ...await reader.readEvidence(ref), payload: raw[3] }) as never })).rejects.toThrow("does not match");
  });

  it("reports logical session and event sequence at the failed inspection breakpoint", async () => {
    const normalized = await normalizeRc1Append(operation());
    const payload = await project(normalized.events.filter((event) => event.kind !== "system-metadata"));
    await expect(inspectRc1({ listNativeSessionIds: async () => [payload.header.id], readSession: async () => payload as unknown as JsonValue }))
      .rejects.toThrow(/synthetic-logical.*assistant\/chunk.*seq 1/);
  });
});
