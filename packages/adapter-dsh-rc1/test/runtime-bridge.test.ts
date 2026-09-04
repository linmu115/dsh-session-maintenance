import { describe, expect, it, vi } from "vitest";
import type { JsonValue, RuntimeHandle } from "@linmu/dsh-session-adapter-sdk";

import { adapter, rc1NativeSessionId, Rc1RuntimeBridge } from "../src/index.js";

const at = "2026-09-01T00:00:00.000Z";

function operation(events: readonly JsonValue[]) {
  return {
    runId: "run-rc1-idempotent" as never,
    operationId: "operation-rc1-idempotent" as never,
    nativeSessionId: rc1NativeSessionId("logical-rc1-idempotent" as never),
    nativeRevision: 3,
    observedAt: at,
    payload: {
      logicalSessionId: "logical-rc1-idempotent",
      baseVersionId: "version-base",
      events,
    },
  } as const;
}

async function attachedBridge(): Promise<{
  readonly bridge: Rc1RuntimeBridge;
  readonly handle: RuntimeHandle;
}> {
  const bridge = new Rc1RuntimeBridge({
    attach: async () => ({ registrationId: "registration-rc1-idempotent", attachedAt: at }),
    drain: async (_registrationId, runId) => ({ runId, pendingOperations: 0, receipts: [] }),
    detach: async () => undefined,
  });
  const handle = await bridge.attach({
    run: {
      schemaVersion: 1,
      id: "run-rc1-idempotent" as never,
      leaseId: "lease-rc1-idempotent" as never,
      branchId: "main" as never,
      instanceId: "rc1-idempotent",
      profileId: "web",
      dshVersion: "0.1.2-rc.1",
      adapterId: "dsh-rc1" as never,
      state: "running",
      startedAt: at,
      heartbeatAt: at,
      checkpointId: null,
    },
    projectionRoot: "fixture://rc1-idempotent",
    maintenanceEndpoint: "http://127.0.0.1:41781",
  });
  return { bridge, handle };
}

describe("Rc1 Runtime Bridge", () => {
  it("gives the DSH registrar only runId and Maintenance endpoint, never a projection path", async () => {
    const registrar = {
      attach: vi.fn(async () => ({ registrationId: "registration-rc1", attachedAt: at })),
      drain: vi.fn(async (_registrationId: string, runId: never) => ({ runId, pendingOperations: 0, receipts: [] })),
      detach: vi.fn(async () => undefined),
    };
    const bridge = new Rc1RuntimeBridge(registrar);
    const run = {
      schemaVersion: 1 as const,
      id: "run-runtime-bridge" as never,
      leaseId: "lease-runtime-bridge" as never,
      branchId: "main" as never,
      instanceId: "rc1",
      profileId: "rc1",
      dshVersion: "0.1.2-rc.1",
      adapterId: adapter.manifest.id,
      state: "preparing" as const,
      startedAt: at,
      heartbeatAt: at,
      checkpointId: null,
    };
    const handle = await bridge.attach({
      run,
      projectionRoot: "D:/must-not-cross-the-bridge/sessions",
      maintenanceEndpoint: "http://127.0.0.1:41781",
    });
    expect(registrar.attach).toHaveBeenCalledWith({
      runId: run.id,
      maintenanceEndpoint: "http://127.0.0.1:41781",
    });
    expect(JSON.stringify(registrar.attach.mock.calls)).not.toContain("projectionRoot");
    expect(JSON.stringify(registrar.attach.mock.calls)).not.toContain("must-not-cross");
    await expect(bridge.drain(handle)).resolves.toMatchObject({ pendingOperations: 0 });
    await expect(bridge.submitAppend({
      runId: run.id,
      operationId: "operation-after-drain" as never,
      nativeSessionId: "native-after-drain" as never,
      nativeRevision: 1,
      payload: { logicalSessionId: "logical-after-drain", events: [] },
      observedAt: at,
    })).rejects.toThrow("draining");
    await bridge.detach(handle);
    await expect(bridge.drain(handle)).rejects.toThrow("not attached");
  });
});

describe("Rc1RuntimeBridge idempotent projection recovery", () => {
  it("registers a live seeded fork with exact lineage before its first append", async () => {
    const { bridge, handle } = await attachedBridge();
    const nativeSessionId = "native-rc1-seeded" as never;
    const logicalSessionId = "logical-rc1-seeded" as never;
    const header = {
      version: 0,
      id: nativeSessionId,
      createdAt: 1,
      cwd: "D:/synthetic/project",
      parentSession: "native-parent",
      isSeeded: true,
    } as const;
    let projection: JsonValue | undefined;
    const mutable = {
      readSession: async () => {
        if (projection === undefined) {
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return projection;
      },
      writeSession: async (_nativeSessionId: never, payload: JsonValue) => { projection = payload; },
      replaceSession: async (_nativeSessionId: never, payload: JsonValue) => { projection = payload; },
    };

    await bridge.registerSession(handle, {
      nativeSessionId,
      logicalSessionId,
      header,
      title: "Seeded fork",
      workspaceId: null,
      projectId: "project-seeded" as never,
      adapterMetadata: { inheritedEventCount: 2 },
    }, mutable);
    expect(projection).toMatchObject({
      inheritedEventCount: 2,
      header: { isSeeded: true, parentSession: "native-parent" },
      events: [],
    });

    const events = [
      { type: "user/message", seq: 0, time: 1, data: { text: "seed" } },
      { type: "assistant/message", seq: 1, time: 2, data: { text: "answer" } },
      { type: "session/end-seed", seq: 2, time: 3, data: {} },
    ] as const;
    await bridge.applyAppend(handle, {
      runId: handle.runId,
      operationId: "operation-rc1-seeded-first" as never,
      nativeSessionId,
      nativeRevision: 3,
      payload: { logicalSessionId, baseVersionId: null, events },
      observedAt: at,
    }, mutable);
    expect((projection as { readonly events: readonly JsonValue[] }).events).toEqual(events);
  });

  it("accepts an already-applied append only when the complete projected tail is identical", async () => {
    const suffix = [
      { type: "assistant/chunk", seq: 1, time: 1, data: { text: "thinking" } },
      { type: "assistant/message", seq: 2, time: 2, data: { text: "answer" } },
    ] as const;
    let projection: JsonValue = {
      logicalSessionId: "logical-rc1-idempotent",
      events: [
        { type: "user/message", seq: 0, time: 0, data: { text: "question" } },
        ...suffix,
      ],
    };
    const { bridge, handle } = await attachedBridge();
    const mutable = {
      readSession: async () => projection,
      replaceSession: async (_nativeSessionId: never, next: JsonValue) => { projection = next; },
    };

    await expect(bridge.validateAppend(handle, operation(suffix), mutable)).resolves.toMatchObject({ appendedEvents: [] });
    await bridge.applyAppend(handle, operation(suffix), mutable);
    expect((projection as { readonly events: readonly JsonValue[] }).events).toHaveLength(3);
  });

  it("replays only the unapplied suffix when a crash persisted part of one append batch", async () => {
    const suffix = [
      { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } },
      { type: "assistant/message", seq: 2, time: 2, data: { text: "answer" } },
    ] as const;
    let projection: JsonValue = {
      logicalSessionId: "logical-rc1-idempotent",
      events: [
        { type: "user/message", seq: 0, time: 0, data: { text: "question" } },
        suffix[0],
      ],
    };
    const { bridge, handle } = await attachedBridge();
    const mutable = {
      readSession: async () => projection,
      replaceSession: async (_nativeSessionId: never, next: JsonValue) => { projection = next; },
    };

    await expect(bridge.validateAppend(handle, operation(suffix), mutable)).resolves.toMatchObject({
      appendedEvents: [suffix[1]],
      alreadyApplied: false,
    });
    await bridge.applyAppend(handle, operation(suffix), mutable);
    expect((projection as { readonly events: readonly JsonValue[] }).events).toEqual([
      { type: "user/message", seq: 0, time: 0, data: { text: "question" } },
      ...suffix,
    ]);
  });

  it("rejects an equal revision when the projected tail differs from the recovery operation", async () => {
    const suffix = [
      { type: "assistant/chunk", seq: 1, time: 1, data: { text: "different" } },
      { type: "assistant/message", seq: 2, time: 2, data: { text: "answer" } },
    ] as const;
    const projection: JsonValue = {
      logicalSessionId: "logical-rc1-idempotent",
      events: [
        { type: "user/message", seq: 0, time: 0, data: { text: "question" } },
        { type: "assistant/chunk", seq: 1, time: 1, data: { text: "thinking" } },
        suffix[1],
      ],
    };
    const { bridge, handle } = await attachedBridge();

    await expect(bridge.validateAppend(handle, operation(suffix), {
      readSession: async () => projection,
    })).rejects.toThrow("Rc1 native revision mismatch: 3 -> 3");
  });
});
