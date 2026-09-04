import { describe, expect, it } from "vitest";
import { defineDshRuntimeBridge, runAdapterCoreSmoke, type AdapterId, type DshRuntimeBridgeV1, type JsonValue, type NativeSessionId, type ProjectionReader, type ProjectionWriter } from "@linmu/dsh-session-adapter-sdk";

import { adapter, rc2NativeSessionId } from "../src/index.js";

const at = "2026-08-31T00:00:00.000Z";

describe("DSH RC2 Adapter Core Smoke", () => {
  it("materializes RC2 headers, preserves unknown events, normalizes append and resolves references", async () => {
    const sessions = new Map<string, JsonValue>();
    const workspaces = new Map<string, JsonValue>();
    const writer: ProjectionWriter = { writeWorkspace: async (id, payload) => { workspaces.set(id, payload); }, writeSession: async (id, payload) => { sessions.set(id, payload); } };
    const reader: ProjectionReader & { listNativeWorkspaceIds(): Promise<readonly string[]> } = { listNativeSessionIds: async () => [...sessions.keys()] as NativeSessionId[], readSession: async (id) => sessions.get(id)!, listNativeWorkspaceIds: async () => [...workspaces.keys()] };
    const bridge: DshRuntimeBridgeV1 = defineDshRuntimeBridge({ attach: async (context) => ({ runId: context.run.id, adapterId: adapter.manifest.id, attachedAt: at }), drain: async (handle) => ({ runId: handle.runId, pendingOperations: 0, receipts: [] }), detach: async () => undefined });
    const logicalSessionId = "logical-rc2-smoke" as never;
    const run = { schemaVersion: 1 as const, id: "run-rc2-smoke" as never, leaseId: "lease-rc2-smoke" as never, branchId: "main" as never, instanceId: "rc2", profileId: "rc2", dshVersion: "0.1.1-rc.2", adapterId: adapter.manifest.id as AdapterId, state: "preparing" as const, startedAt: at, heartbeatAt: at, checkpointId: null };
    const heldOut = { type: "plugin/rc2-future", seq: 1, time: Date.parse(at) + 1, data: { retained: true }, ignorable: true } as const;
    const result = await runAdapterCoreSmoke({
      adapter, bridge,
      environment: { dshVersion: run.dshVersion, packageVersions: { "@deepseek-ai/dsh-session": "0.1.1-rc.2" }, runtimeCapabilities: ["legacySessionPersistence"] },
      projection: { run, workspaces: [{ schemaVersion: 1, id: "workspace-rc2" as never, parentId: null, name: "RC2", sortKey: "a", deletedAt: null, createdAt: at, updatedAt: at }], sessions: [{ session: { schemaVersion: 1, id: logicalSessionId, authorityScope: "maintenance", originKind: "maintenance-native", headVersionId: "version-rc2" as never, title: "RC2 fixture", tags: ["fixture"], archivedAt: null, tombstonedAt: null, createdAt: at, updatedAt: at }, events: [{ schemaVersion: 1, id: "event-user", logicalSessionId, sequence: 0, kind: "user-message", role: "user", content: { content: [{ type: "text", text: "hello" }] }, source: { platform: "dsh", instanceId: "fixture", sessionId: "source", eventId: "0", cursor: "0" }, contentDigest: "sha256:user", rawPayload: null, extensions: {} }, { schemaVersion: 1, id: "event-held", logicalSessionId, sequence: 1, kind: "opaque-unknown", role: "unknown", content: heldOut.data, source: { platform: "dsh", instanceId: "fixture", sessionId: "source", eventId: "1", cursor: "1" }, contentDigest: "sha256:held", rawPayload: heldOut, extensions: { heldOut: true } }], workspaceId: "workspace-rc2" as never }] },
      writer, reader,
      append: { runId: run.id, operationId: "operation-rc2" as never, nativeSessionId: rc2NativeSessionId(logicalSessionId), nativeRevision: 3, payload: { logicalSessionId, baseVersionId: "version-rc2", events: [{ type: "assistant/message", seq: 2, time: Date.parse(at) + 2, data: { content: [{ type: "text", text: "answer" }] } }, { type: "plugin/unmanaged", seq: 3, time: Date.parse(at) + 3, data: { retained: true } }] }, observedAt: at },
      attach: { run, projectionRoot: "fixture://rc2", maintenanceEndpoint: "http://127.0.0.1:1" },
      reference: { logicalSessionId, logicalAnchorId: "event-user", legacyNativeSessionId: null },
    });
    expect(result).toMatchObject({ ok: true, probe: { status: "verified" }, verification: { ok: true }, append: { events: [expect.objectContaining({ kind: "assistant-message" }), expect.objectContaining({ kind: "opaque-unknown" })] }, reference: { nativeSessionId: rc2NativeSessionId(logicalSessionId), nativeAnchorId: "event-user" } });
    expect(result.inspection.issues).toContainEqual(expect.objectContaining({ code: "RC2_EVENT_HELD_OUT" }));
    expect((sessions.get(rc2NativeSessionId(logicalSessionId)) as { readonly header: { readonly type: string; readonly version: number } }).header).toEqual(expect.objectContaining({ type: "session", version: 0 }));
  });
});
