import { describe, expect, it } from "vitest";
import type {
  AdapterId,
  DshRuntimeBridgeV1,
  DshSessionAdapterV1,
  JsonValue,
  NativeSessionId,
  ProjectionReader,
  ProjectionWriter,
} from "@linmu/dsh-session-contracts";

import {
  defineAdapterManifest,
  defineDshRuntimeBridge,
  defineDshSessionAdapter,
  negotiateAdapterManifest,
  runAdapterCoreSmoke,
} from "../src/index.js";

const at = "2026-08-31T00:00:00.000Z";

function fixture() {
  const calls: string[] = [];
  const sessions = new Map<string, JsonValue>();
  const writer: ProjectionWriter = {
    writeWorkspace: async () => undefined,
    writeSession: async (id, payload) => { sessions.set(id, payload); },
  };
  const reader: ProjectionReader = {
    listNativeSessionIds: async () => [...sessions.keys()] as NativeSessionId[],
    readSession: async (id) => sessions.get(id)!,
  };
  const manifest = defineAdapterManifest({
    schemaVersion: 1,
    id: "minimal-experimental" as AdapterId,
    displayName: "Minimal experimental Adapter",
    adapterApiVersion: 1,
    packageVersion: "0.1.0",
    testedDshVersions: [],
    declaredDshRange: "<0.1.0",
    capabilities: ["session-persistence", "append", "projection-verification"],
  });
  const adapter: DshSessionAdapterV1 = defineDshSessionAdapter({
    manifest,
    probe: async (environment) => ({
      status: "experimental",
      manifest,
      detectedDshVersion: environment.dshVersion,
      capabilities: manifest.capabilities,
      issues: [],
    }),
    materialize: async (input, output) => {
      calls.push("materialize");
      await output.writeSession("native-session-1" as NativeSessionId, { events: input.sessions[0]!.events });
      return {
        schemaVersion: 1,
        runId: input.run.id,
        adapterId: manifest.id,
        sessionCount: 1,
        workspaceCount: 0,
        catalogDigest: "sha256:catalog",
        sessionDigests: { "native-session-1": "sha256:session" },
      };
    },
    normalizeAppend: async (operation) => {
      calls.push("append");
      return {
        runId: operation.runId,
        operationId: operation.operationId,
        nativeSessionId: operation.nativeSessionId,
        logicalSessionId: "logical-session-1" as never,
        baseVersionId: null,
        events: [],
        metadata: operation.payload,
      };
    },
    inspect: async (projection) => {
      calls.push("inspect");
      return {
        sessionCount: (await projection.listNativeSessionIds()).length,
        workspaceCount: 0,
        catalogDigest: "sha256:catalog",
        sessionDigests: { "native-session-1": "sha256:session" },
        issues: [],
      };
    },
    verify: async (expected, actual) => ({
      ok: expected.catalogDigest === actual.catalogDigest,
      status: "experimental",
      issues: [],
    }),
    resolveReference: async (reference) => ({
      logicalSessionId: reference.logicalSessionId,
      nativeSessionId: "native-session-1" as NativeSessionId,
      nativeAnchorId: reference.logicalAnchorId,
      status: "resolved",
    }),
  });
  const bridge: DshRuntimeBridgeV1 = defineDshRuntimeBridge({
    attach: async (context) => {
      calls.push("attach");
      return { runId: context.run.id, adapterId: manifest.id, attachedAt: at };
    },
    drain: async (handle) => {
      calls.push("drain");
      return { runId: handle.runId, pendingOperations: 0, receipts: [] };
    },
    detach: async () => { calls.push("detach"); },
  });
  return { adapter, bridge, writer, reader, calls };
}

describe("Adapter SDK conformance", () => {
  it("runs an experimental minimal Adapter through one-session Core Smoke", async () => {
    const { adapter, bridge, writer, reader, calls } = fixture();
    const run = {
      schemaVersion: 1 as const,
      id: "run-smoke" as never,
      leaseId: "lease-smoke" as never,
      branchId: "main" as never,
      instanceId: "launcher-smoke",
      profileId: "profile-smoke",
      dshVersion: "0.1.2-alpha.999",
      adapterId: adapter.manifest.id,
      state: "preparing" as const,
      startedAt: at,
      heartbeatAt: at,
      checkpointId: null,
    };
    const result = await runAdapterCoreSmoke({
      adapter,
      bridge,
      environment: {
        dshVersion: run.dshVersion,
        packageVersions: {},
        runtimeCapabilities: ["sessionPersistence"],
      },
      projection: {
        run,
        workspaces: [],
        sessions: [{
          session: {
            schemaVersion: 1,
            id: "logical-session-1" as never,
            authorityScope: "maintenance",
            originKind: "maintenance-native",
            headVersionId: null,
            title: "Smoke",
            tags: [],
            archivedAt: null,
            tombstonedAt: null,
            createdAt: at,
            updatedAt: at,
          },
          events: [],
          workspaceId: null,
        }],
      },
      writer,
      reader,
      append: {
        runId: run.id,
        operationId: "operation-smoke" as never,
        nativeSessionId: "native-session-1" as NativeSessionId,
        nativeRevision: 1,
        payload: { type: "append" },
        observedAt: at,
      },
      attach: {
        run,
        projectionRoot: "fixture://projection",
        maintenanceEndpoint: "http://127.0.0.1:1",
      },
      reference: {
        logicalSessionId: "logical-session-1" as never,
        logicalAnchorId: "anchor-1",
        legacyNativeSessionId: null,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      probe: { status: "experimental" },
      projection: { sessionCount: 1, catalogDigest: "sha256:catalog" },
      inspection: { sessionCount: 1, catalogDigest: "sha256:catalog" },
      append: { nativeSessionId: "native-session-1" },
      reference: { status: "resolved" },
      drain: { pendingOperations: 0 },
    });
    expect(calls).toEqual(["materialize", "inspect", "append", "attach", "drain", "detach"]);
  });

  it("reports an unsupported adapterApiVersion without importing the Adapter", () => {
    expect(negotiateAdapterManifest({
      schemaVersion: 1,
      id: "future-adapter",
      displayName: "Future Adapter",
      adapterApiVersion: 2,
      packageVersion: "2.0.0",
      testedDshVersions: [],
      declaredDshRange: "*",
      capabilities: [],
    })).toEqual({
      ok: false,
      status: "failed",
      issues: [{
        code: "ADAPTER_API_UNSUPPORTED",
        message: "Adapter API major 2 is not supported; this Core accepts major 1",
      }],
    });
  });

  it("keeps the third-party minimal example dependent on the public SDK only", async () => {
    const packageJson = JSON.parse(await readFile(
      new URL("../../../docs/adapters/examples/minimal-adapter/package.json", import.meta.url),
      "utf8",
    )) as { readonly dependencies: Readonly<Record<string, string>> };
    expect(Object.keys(packageJson.dependencies)).toEqual(["@linmu/dsh-session-adapter-sdk"]);
  });
});
import { readFile } from "node:fs/promises";
