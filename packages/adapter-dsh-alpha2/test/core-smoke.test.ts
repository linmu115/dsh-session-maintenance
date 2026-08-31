import { describe, expect, it } from "vitest";
import {
  defineDshRuntimeBridge,
  runAdapterCoreSmoke,
  type AdapterId,
  type DshRuntimeBridgeV1,
  type JsonValue,
  type NativeSessionId,
  type ProjectionReader,
  type ProjectionWriter,
} from "@linmu/dsh-session-adapter-sdk";

import { adapter, alpha2NativeSessionId } from "../src/index.js";

const at = "2026-08-31T00:00:00.000Z";

describe("DSH Alpha2 Adapter Core Smoke", () => {
  it("materializes, verifies and normalizes one synthetic Alpha2 session without losing unknown events", async () => {
    const sessions = new Map<string, JsonValue>();
    const writer: ProjectionWriter = {
      writeWorkspace: async () => undefined,
      writeSession: async (id, payload) => { sessions.set(id, payload); },
    };
    const reader: ProjectionReader = {
      listNativeSessionIds: async () => [...sessions.keys()] as NativeSessionId[],
      readSession: async (id) => sessions.get(id)!,
    };
    const bridge: DshRuntimeBridgeV1 = defineDshRuntimeBridge({
      attach: async (context) => ({ runId: context.run.id, adapterId: adapter.manifest.id, attachedAt: at }),
      drain: async (handle) => ({ runId: handle.runId, pendingOperations: 0, receipts: [] }),
      detach: async () => undefined,
    });
    const logicalSessionId = "logical-alpha2-smoke" as never;
    const run = {
      schemaVersion: 1 as const,
      id: "run-alpha2-smoke" as never,
      leaseId: "lease-alpha2-smoke" as never,
      branchId: "main" as never,
      instanceId: "launcher-alpha2-smoke",
      profileId: "profile-alpha2-smoke",
      dshVersion: "0.1.2-alpha.2",
      adapterId: adapter.manifest.id as AdapterId,
      state: "preparing" as const,
      startedAt: at,
      heartbeatAt: at,
      checkpointId: null,
    };
    const heldOut = {
      type: "plugin/future-event",
      seq: 2,
      time: Date.parse(at) + 2,
      data: { preserved: true },
      ignorable: true,
    } as const;
    const result = await runAdapterCoreSmoke({
      adapter,
      bridge,
      environment: {
        dshVersion: run.dshVersion,
        packageVersions: {
          "@deepseek-ai/dsh-session": "0.1.2-alpha.2",
          "@deepseek-ai/dsh-session-persistence": "0.1.2-alpha.2",
        },
        runtimeCapabilities: ["sessionPersistence", "sessionPersistence.inspect", "sessionPersistence.append"],
      },
      projection: {
        run,
        workspaces: [{
          schemaVersion: 1,
          id: "workspace-alpha2-smoke" as never,
          parentId: null,
          name: "Synthetic workspace",
          sortKey: "0001",
          deletedAt: null,
          createdAt: at,
          updatedAt: at,
        }],
        sessions: [{
          session: {
            schemaVersion: 1,
            id: logicalSessionId,
            authorityScope: "maintenance",
            originKind: "maintenance-native",
            headVersionId: null,
            title: "Synthetic Alpha2 session",
            tags: ["fixture"],
            archivedAt: null,
            tombstonedAt: null,
            createdAt: at,
            updatedAt: at,
          },
          events: [{
            schemaVersion: 1,
            id: "event-user",
            logicalSessionId,
            sequence: 0,
            kind: "user-message",
            role: "user",
            content: { role: "user", content: [{ type: "text", text: "synthetic prompt" }], source: { kind: "user" } },
            source: { platform: "dsh", instanceId: "fixture", sessionId: "source", eventId: "0", cursor: "0" },
            contentDigest: "sha256:user",
            rawPayload: null,
            extensions: {},
          }, {
            schemaVersion: 1,
            id: "event-assistant",
            logicalSessionId,
            sequence: 1,
            kind: "assistant-message",
            role: "assistant",
            content: { turn: 0, step: 0, message: { role: "assistant", content: [{ type: "text", text: "synthetic answer" }] } },
            source: { platform: "dsh", instanceId: "fixture", sessionId: "source", eventId: "1", cursor: "1" },
            contentDigest: "sha256:assistant",
            rawPayload: null,
            extensions: {},
          }, {
            schemaVersion: 1,
            id: "event-held-out",
            logicalSessionId,
            sequence: 2,
            kind: "opaque-unknown",
            role: "unknown",
            content: heldOut.data,
            source: { platform: "dsh", instanceId: "fixture", sessionId: "source", eventId: "2", cursor: "2" },
            contentDigest: "sha256:held-out",
            rawPayload: heldOut,
            extensions: { dshEventType: heldOut.type, heldOut: true },
          }],
          workspaceId: "workspace-alpha2-smoke" as never,
        }],
      },
      writer,
      reader,
      append: {
        runId: run.id,
        operationId: "operation-alpha2-smoke" as never,
        nativeSessionId: alpha2NativeSessionId(logicalSessionId),
        nativeRevision: 4,
        payload: {
          logicalSessionId,
          baseVersionId: null,
          instanceId: "launcher-alpha2-smoke",
          events: [{
            type: "user/message",
            seq: 3,
            time: Date.parse(at) + 3,
            data: { role: "user", content: [{ type: "text", text: "continued" }], source: { kind: "user" } },
            surfaceOp: "append",
          }, {
            type: "plugin/unknown-required",
            seq: 4,
            time: Date.parse(at) + 4,
            data: { mustRoundTrip: true },
          }],
        },
        observedAt: at,
      },
      attach: {
        run,
        projectionRoot: "fixture://alpha2-projection",
        maintenanceEndpoint: "http://127.0.0.1:1",
      },
      reference: {
        logicalSessionId,
        logicalAnchorId: "event-assistant",
        legacyNativeSessionId: null,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      probe: { status: "verified" },
      projection: { sessionCount: 1, workspaceCount: 1 },
      inspection: {
        sessionCount: 1,
        workspaceCount: 1,
        issues: [expect.objectContaining({ code: "ALPHA2_EVENT_HELD_OUT" })],
      },
      verification: { ok: true, status: "verified" },
      append: {
        logicalSessionId,
        events: [
          expect.objectContaining({ kind: "user-message", sequence: 3 }),
          expect.objectContaining({
            kind: "opaque-unknown",
            sequence: 4,
            rawPayload: expect.objectContaining({ type: "plugin/unknown-required" }),
          }),
        ],
      },
      reference: {
        nativeSessionId: alpha2NativeSessionId(logicalSessionId),
        nativeAnchorId: "event-assistant",
        status: "resolved",
      },
    });
    expect(result.projection.catalogDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.projection.sessionDigests[alpha2NativeSessionId(logicalSessionId)]).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect((sessions.get(alpha2NativeSessionId(logicalSessionId)) as { readonly events: readonly JsonValue[] }).events[2]).toEqual(heldOut);
  });
});
