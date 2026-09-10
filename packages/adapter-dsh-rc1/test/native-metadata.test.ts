import { describe, expect, it } from "vitest";
import type { AdapterEvidencePort, CanonicalProjectionInput, NativeAppendOperation } from "@linmu/dsh-session-adapter-sdk";
import { adapter, normalizeRc1Append, materializeRc1, rc1ProjectedNativeRevision } from "../src/index.js";
import { NATIVE_METADATA_TYPES, restoreRc1Metadata } from "../src/native-metadata.js";
import { sourceWithEvidence } from "../../projection-lifecycle/src/source-evidence.js";

const at = "2026-09-09T00:00:00.000Z";
const native = [...NATIVE_METADATA_TYPES].map((type, seq) => ({ type, seq, time: Date.parse(at) + seq,
  data: type === "dsh-runtime/detail" ? { id: "execution", phase: "start", model: "astra", state: "completed", items: [] }
    : { title: "title", provider: "deepseek", model: "native", messageSeqs: [], source: { kind: "user" } } }));
const readableNative = native.map(event => event.type === "dsh-runtime/detail" ? { ...event, ignorable: true } : event);
const operation = (events: unknown[], mode = "native") => ({ runId: "synthetic-run", operationId: "synthetic-op", nativeSessionId: "synthetic-session", nativeRevision: events.length,
  observedAt: at, payload: { logicalSessionId: "logical", events, canonicalHistoryMode: mode } }) as NativeAppendOperation;
async function project(events: any[]) {
  let payload: any;
  const input = { run: { id: "synthetic-run" }, workspaces: [], sessions: [{ session: { id: "logical", title: "title", tags: [], createdAt: at, updatedAt: at, headVersionId: "v" }, events, workspaceId: null, projectRoot: null }] } as CanonicalProjectionInput;
  await materializeRc1(input, { writeWorkspace: async () => {}, writeSession: async (_id, value) => { payload = value; } });
  expect(rc1ProjectedNativeRevision(input.sessions[0]!, payload)).toBe(native.length);
  return payload;
}
describe("RC1 native metadata", () => {
  it("retains native state and Codex detail across repeated roundtrips; portable history omits controls", async () => {
    const normalized = await normalizeRc1Append(operation(native));
    expect(normalized.events.every(e => e.kind === "system-metadata")).toBe(true);
    const first = await project([...normalized.events]);
    expect(first.events).toEqual(readableNative);
    const second = await project([...(await normalizeRc1Append(operation(first.events))).events]);
    expect(second.events).toEqual(first.events);
    expect((await normalizeRc1Append(operation(native, "portable"))).events).toEqual([]);
  });
  it("restores exact historical evidence consistently for full, incremental and pinned reads", async () => {
    const current = (await normalizeRc1Append(operation(native))).events;
    const historical = current.map(e => ({ ...e, kind: "other" as const, rawPayload: null, content: { sourceKind: `dsh-rc1/${e.extensions.dshEventType}`, evidenceRef: String(e.sequence) }, extensions: { ...e.extensions, heldOut: true } }));
    const before = JSON.stringify(historical);
    const evidence = { readEvidence: async (ref: string) => ({ adapterId: "dsh-rc1", nativeFormatId: "dsh/0.1.2-rc.1/session-event-v1", sourceKind: `dsh-rc1/${native[Number(ref)]!.type}`, payload: native[Number(ref)] }) } as unknown as AdapterEvidencePort;
    const input = { sessions: [{ events: historical }] } as unknown as CanonicalProjectionInput;
    const source: any = sourceWithEvidence({ load: async () => input, loadVersionEvents: async () => historical,
      currentRevision: async () => 1, listChanges: async () => ({ changes: [] }), loadSessions: async () => input } as any, adapter, evidence);
    const full = await source.load({}), delta = await source.loadSessions({}, ["logical"]), pinned = await source.loadVersionEvents("logical", "v");
    expect(full.sessions[0].events).toEqual(delta.sessions[0].events);
    expect(full.sessions[0].events).toEqual(pinned);
    expect((await project(pinned)).events).toEqual(readableNative);
    expect(JSON.stringify(historical)).toBe(before);
    await expect(restoreRc1Metadata(historical, { readEvidence: async () => ({ ...(await evidence.readEvidence("0" as never))!, payload: { ...native[0], type: "user/message" } }) } as any)).rejects.toThrow("does not match");
    expect(await restoreRc1Metadata(historical, { readEvidence: async () => undefined })).toEqual(historical);
    const portable = historical.map(e => ({ ...e, extensions: { ...e.extensions, portableFromRc1: true } }));
    expect(await restoreRc1Metadata(portable, evidence)).toEqual(portable);
  });
});
