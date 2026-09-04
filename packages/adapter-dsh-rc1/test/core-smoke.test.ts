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

import { adapter, rc1NativeSessionId } from "../src/index.js";

const at = "2026-08-31T00:00:00.000Z";

describe("DSH Rc1 Adapter Core Smoke", () => {
  it("maps every logical id to a deterministic path-safe native session id", () => {
    const logicalSessionId = "logical:rc1/unsafe path" as never;
    const nativeSessionId = rc1NativeSessionId(logicalSessionId);

    expect(nativeSessionId).toBe(rc1NativeSessionId(logicalSessionId));
    expect(nativeSessionId).toMatch(/^[a-zA-Z0-9_-]+$/u);
    expect(nativeSessionId).not.toContain(":");
  });

  it("materializes, verifies and normalizes one synthetic Rc1 session without losing unknown events", async () => {
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
    const logicalSessionId = "logical-rc1-smoke" as never;
    const run = {
      schemaVersion: 1 as const,
      id: "run-rc1-smoke" as never,
      leaseId: "lease-rc1-smoke" as never,
      branchId: "main" as never,
      instanceId: "launcher-rc1-smoke",
      profileId: "profile-rc1-smoke",
      dshVersion: "0.1.2-rc.1",
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
          "@deepseek-ai/dsh-session": "0.1.2-rc.1",
          "@deepseek-ai/dsh-session-persistence": "0.1.2-rc.1",
        },
        runtimeCapabilities: ["sessionPersistence", "sessionPersistence.inspect", "sessionPersistence.append"],
      },
      projection: {
        run,
        workspaces: [{
          schemaVersion: 1,
          id: "workspace-rc1-smoke" as never,
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
            title: "Synthetic Rc1 session",
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
            extensions: {
              "mcsf.conversationTopology.v1": {
                schemaVersion: 1,
                turnId: "turn-smoke-0",
                turnOrdinal: 0,
                stepId: "turn-smoke-0:step-0",
                stepOrdinal: 0,
                phase: "user",
                inference: "explicit",
              },
            },
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
            extensions: {
              "mcsf.conversationTopology.v1": {
                schemaVersion: 1,
                turnId: "turn-smoke-0",
                turnOrdinal: 0,
                stepId: "turn-smoke-0:step-0",
                stepOrdinal: 0,
                phase: "assistant",
                inference: "explicit",
              },
            },
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
          workspaceId: "workspace-rc1-smoke" as never,
          projectId: "project-rc1-smoke" as never,
          projectRoot: "D:\\fixture\\project-root",
        }],
      },
      writer,
      reader,
      append: {
        runId: run.id,
        operationId: "operation-rc1-smoke" as never,
        nativeSessionId: rc1NativeSessionId(logicalSessionId),
        nativeRevision: 4,
        payload: {
          logicalSessionId,
          baseVersionId: null,
          instanceId: "launcher-rc1-smoke",
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
        projectionRoot: "fixture://rc1-projection",
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
        issues: [expect.objectContaining({ code: "RC1_EVENT_HELD_OUT" })],
      },
      verification: { ok: true, status: "verified" },
      append: {
        logicalSessionId,
        events: [
          expect.objectContaining({ kind: "user-message", sequence: 3 }),
          expect.objectContaining({
            kind: "other",
            sequence: 4,
            role: "unknown",
            rawPayload: null,
            content: expect.objectContaining({
              type: "other",
              reason: "unsupported-source-event",
              sourceKind: "dsh-rc1/plugin/unknown-required",
            }),
          }),
        ],
      },
      reference: {
        nativeSessionId: rc1NativeSessionId(logicalSessionId),
        nativeAnchorId: "event-assistant",
        status: "resolved",
      },
    });
    expect(result.projection.catalogDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.projection.sessionDigests[rc1NativeSessionId(logicalSessionId)]).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const projected = sessions.get(rc1NativeSessionId(logicalSessionId)) as {
      readonly workspaceId: string;
      readonly inheritedEventCount: number;
      readonly header: { readonly cwd?: string; readonly isSeeded?: boolean };
      readonly events: readonly JsonValue[];
    };
    expect(projected.header.cwd).toBe("D:\\fixture\\project-root");
    expect(projected.header.isSeeded).toBe(false);
    expect(projected.inheritedEventCount).toBe(0);
    expect(projected.workspaceId).toBe("workspace-rc1-smoke");
    expect(projected.events[0]).toMatchObject({ type: "turn/start", data: { turn: 1 } });
    expect(projected.events[1]).toMatchObject({
      type: "user/message",
      data: {
        id: "event-user",
        role: "user",
        source: { kind: "user" },
      },
    });
    expect(projected.events[2]).toMatchObject({ type: "step/start", data: { turn: 1, step: 1 } });
    expect(projected.events[3]).toMatchObject({
      type: "assistant/message",
      data: {
        message: {
          id: "event-assistant",
          role: "assistant",
          source: { kind: "model", provider: "codex", model: "imported" },
        },
      },
    });
    expect(projected.events[4]).toMatchObject({ type: "step/end", data: { turn: 1, step: 1 } });
    expect(projected.events[5]).toMatchObject({ type: "turn/end", data: { turn: 1 } });
    expect(projected.events[6]).toEqual({ ...heldOut, seq: 6 });
  });

  it("materializes Codex text and attachment rows as identified Rc1 messages", async () => {
    const sessions = new Map<string, JsonValue>();
    const writer: ProjectionWriter = {
      writeWorkspace: async () => undefined,
      writeSession: async (id, payload) => { sessions.set(id, payload); },
    };
    const logicalSessionId = "logical-codex-message" as never;
    await adapter.materialize({
      run: {
        schemaVersion: 1,
        id: "run-codex-message" as never,
        leaseId: "lease-codex-message" as never,
        branchId: "main" as never,
        instanceId: "launcher-codex-message",
        profileId: "profile-codex-message",
        dshVersion: "0.1.2-rc.1",
        adapterId: adapter.manifest.id as AdapterId,
        state: "preparing",
        startedAt: at,
        heartbeatAt: at,
        checkpointId: null,
      },
      workspaces: [],
      sessions: [{
        session: {
          schemaVersion: 1,
          id: logicalSessionId,
          authorityScope: "codex",
          originKind: "codex-mirror",
          headVersionId: null,
          title: "Imported Codex session",
          tags: [],
          archivedAt: null,
          tombstonedAt: null,
          createdAt: at,
          updatedAt: at,
        },
        workspaceId: null,
        projectId: null,
        projectRoot: null,
        events: [{
          schemaVersion: 1,
          id: "codex-user-event",
          logicalSessionId,
          sequence: 0,
          kind: "user-message",
          role: "user",
          content: {
            text: "read this file",
            attachments: [{ name: "notes.md", source: "C:\\vault\\notes.md" }],
          },
          source: { platform: "codex", instanceId: "codex", sessionId: "thread", eventId: "0", cursor: "0" },
          contentDigest: "sha256:codex-user",
          rawPayload: null,
          extensions: {
            "mcsf.conversationTopology.v1": {
              schemaVersion: 1,
              turnId: "turn-codex-message-0",
              turnOrdinal: 0,
              stepId: "turn-codex-message-0:step-0",
              stepOrdinal: 0,
              phase: "user",
              inference: "explicit",
            },
          },
        }, {
          schemaVersion: 1,
          id: "codex-assistant-event",
          logicalSessionId,
          sequence: 1,
          kind: "assistant-message",
          role: "assistant",
          content: { text: "done", attachments: [] },
          source: { platform: "codex", instanceId: "codex", sessionId: "thread", eventId: "1", cursor: "1" },
          contentDigest: "sha256:codex-assistant",
          rawPayload: null,
          extensions: {
            "mcsf.conversationTopology.v1": {
              schemaVersion: 1,
              turnId: "turn-codex-message-0",
              turnOrdinal: 0,
              stepId: "turn-codex-message-0:step-0",
              stepOrdinal: 0,
              phase: "assistant",
              inference: "explicit",
            },
          },
        }],
      }],
    }, writer);

    const projected = sessions.get(rc1NativeSessionId(logicalSessionId)) as {
      readonly events: readonly Array<{ readonly data: Record<string, unknown> }>;
    };
    expect(projected.events[1]?.data).toEqual({
      id: "codex-user-event",
      role: "user",
      content: [
        { type: "text", text: "read this file" },
        { type: "text", text: "\n\n附件：notes.md" },
      ],
      source: { kind: "user" },
    });
    expect(projected.events[3]?.data).toEqual({
      turn: 1,
      step: 1,
      message: {
        id: "codex-assistant-event",
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        source: { kind: "model", provider: "codex", model: "imported" },
      },
    });
  });

  it("expands canonical Rc1 packed rows back into contiguous native events", async () => {
    const sessions = new Map<string, JsonValue>();
    const writer: ProjectionWriter = {
      writeWorkspace: async () => undefined,
      writeSession: async (id, payload) => { sessions.set(id, payload); },
    };
    const logicalSessionId = "logical-rc1-packed" as never;
    await adapter.materialize({
      run: {
        schemaVersion: 1,
        id: "run-rc1-packed" as never,
        leaseId: "lease-rc1-packed" as never,
        branchId: "main" as never,
        instanceId: "launcher-rc1-packed",
        profileId: "profile-rc1-packed",
        dshVersion: "0.1.2-rc.1",
        adapterId: adapter.manifest.id as AdapterId,
        state: "preparing",
        startedAt: at,
        heartbeatAt: at,
        checkpointId: null,
      },
      workspaces: [],
      sessions: [{
        session: {
          schemaVersion: 1,
          id: logicalSessionId,
          authorityScope: "maintenance",
          originKind: "maintenance-native",
          headVersionId: null,
          title: "Packed Rc1 session",
          tags: [],
          archivedAt: null,
          tombstonedAt: null,
          createdAt: at,
          updatedAt: at,
        },
        workspaceId: null,
        projectId: null,
        projectRoot: null,
        events: [{
          schemaVersion: 1,
          id: "event-chunk-start",
          logicalSessionId,
          sequence: 0,
          kind: "reasoning",
          role: "assistant",
          content: { turn: 0, step: 0, chunk: { type: "block-start", index: 0, blockType: "reasoning" } },
          source: { platform: "dsh", instanceId: "fixture", sessionId: "source", eventId: "0", cursor: "4" },
          contentDigest: "sha256:chunk-start",
          rawPayload: {
            type: "assistant/chunk",
            seq: 0,
            time: Date.parse(at),
            data: { turn: 0, step: 0, chunk: { type: "block-start", index: 0, blockType: "reasoning" } },
          },
          extensions: {},
        }, {
          schemaVersion: 1,
          id: "event-packed",
          logicalSessionId,
          sequence: 1,
          kind: "opaque-unknown",
          role: "unknown",
          content: { turn: 0, step: 0, index: 0, dt: [1, 2], texts: ["a", "b", "c"] },
          source: { platform: "dsh", instanceId: "fixture", sessionId: "source", eventId: "1", cursor: "4" },
          contentDigest: "sha256:packed",
          rawPayload: {
            type: "reasoning-chunks",
            seq: 1,
            time: Date.parse(at) + 1,
            data: { turn: 0, step: 0, index: 0, dt: [1, 2], texts: ["a", "b", "c"] },
          },
          extensions: { heldOut: true },
        }, {
          schemaVersion: 1,
          id: "event-message",
          logicalSessionId,
          sequence: 4,
          kind: "assistant-message",
          role: "assistant",
          content: { turn: 0, step: 0, message: { role: "assistant", content: [{ type: "text", text: "abc" }] } },
          source: { platform: "dsh", instanceId: "fixture", sessionId: "source", eventId: "4", cursor: "4" },
          contentDigest: "sha256:message",
          rawPayload: {
            type: "assistant/message",
            seq: 4,
            time: Date.parse(at) + 5,
            data: { turn: 0, step: 0, message: { role: "assistant", content: [{ type: "text", text: "abc" }] } },
            sourceEventSeqs: [[0, 3]],
            surfaceOp: "append",
          },
          extensions: {},
        }],
      }],
    }, writer);

    const projected = sessions.get(rc1NativeSessionId(logicalSessionId)) as {
      readonly events: readonly Array<{ readonly type: string; readonly seq: number; readonly sourceEventSeqs?: readonly number[] }>;
    };
    expect(projected.events.map((event) => [event.type, event.seq])).toEqual([
      ["assistant/chunk", 0],
      ["assistant/chunk", 1],
      ["assistant/chunk", 2],
      ["assistant/chunk", 3],
      ["assistant/message", 4],
    ]);
    expect(projected.events[4]?.sourceEventSeqs).toEqual([0, 1, 2, 3]);
  });
});
