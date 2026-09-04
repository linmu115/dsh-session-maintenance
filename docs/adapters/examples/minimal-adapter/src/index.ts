import {
  defineAdapterManifest,
  defineDshRuntimeBridge,
  defineDshSessionAdapter,
  type AdapterId,
  type NativeSessionId,
} from "@linmu/dsh-session-adapter-sdk";

export const manifest = defineAdapterManifest({
  schemaVersion: 1,
  id: "example-minimal" as AdapterId,
  displayName: "Minimal Adapter example",
  adapterApiVersion: 1,
  packageVersion: "0.1.0",
  testedDshVersions: [],
  declaredDshRange: "*",
  capabilities: ["session-persistence", "projection-verification"],
});

export const adapter = defineDshSessionAdapter({
  manifest,
  probe: async (environment) => ({
    status: "experimental" as const,
    manifest,
    detectedDshVersion: environment.dshVersion,
    capabilities: manifest.capabilities,
    issues: [],
  }),
  materialize: async (input, output) => {
    for (const item of input.sessions) {
      await output.writeSession(item.session.id as unknown as NativeSessionId, {
        session: item.session,
        events: item.events,
      });
    }
    return {
      schemaVersion: 1,
      runId: input.run.id,
      adapterId: manifest.id,
      sessionCount: input.sessions.length,
      workspaceCount: input.workspaces.length,
      catalogDigest: "replace-with-deterministic-digest",
      sessionDigests: {},
    };
  },
  normalizeAppend: async () => {
    throw new Error("Add the native append codec before declaring append capability");
  },
  inspect: async (reader) => ({
    sessionCount: (await reader.listNativeSessionIds()).length,
    workspaceCount: 0,
    catalogDigest: "replace-with-deterministic-digest",
    sessionDigests: {},
    issues: [],
  }),
  verify: async (expected, actual) => ({
    ok: expected.catalogDigest === actual.catalogDigest,
    status: "experimental" as const,
    issues: [],
  }),
  resolveReference: async (reference) => ({
    logicalSessionId: reference.logicalSessionId,
    nativeSessionId: reference.logicalSessionId as unknown as NativeSessionId,
    nativeAnchorId: reference.logicalAnchorId,
    status: "resolved" as const,
  }),
});

export const runtimeBridge = defineDshRuntimeBridge({
  attach: async (context) => ({ runId: context.run.id, adapterId: manifest.id, attachedAt: new Date().toISOString() }),
  drain: async (handle) => ({ runId: handle.runId, pendingOperations: 0, receipts: [] }),
  detach: async () => undefined,
});
