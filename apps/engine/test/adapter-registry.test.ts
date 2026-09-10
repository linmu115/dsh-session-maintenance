import { adapter as alpha2Adapter } from "@linmu/dsh-session-adapter-alpha2";
import { adapter as rc1Adapter } from "@linmu/dsh-session-adapter-rc1";
import { adapter as rc2Adapter } from "@linmu/dsh-session-adapter-rc2";
import { NodeAdapterWorkerFactory } from "@linmu/dsh-session-adapter-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterId, BranchId } from "@linmu/dsh-session-contracts";

import { createEngineFixture } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("Adapter Registry API", () => {
  it("lists npm, local and Generation registrations without loading them", async () => {
    const fixture = await createEngineFixture("adapter-registry-api");
    cleanups.push(fixture.cleanupAll);
    const baseManifest = {
      schemaVersion: 1 as const,
      displayName: "Registry fixture",
      adapterApiVersion: 1 as const,
      packageVersion: "1.0.0",
      testedDshVersions: [],
      declaredDshRange: "*",
      capabilities: [] as const,
    };
    await fixture.engine.adapterRegistry.register({
      manifest: { ...baseManifest, id: "registry-npm" as AdapterId },
      source: { kind: "npm", packageName: "registry-npm", entryPoint: "fixture://npm" },
      enabled: true,
    });
    await fixture.engine.adapterRegistry.register({
      manifest: { ...baseManifest, id: "registry-local" as AdapterId },
      source: { kind: "local", directory: fixture.root, entryPoint: "fixture://local" },
      enabled: true,
    });
    await fixture.engine.adapterRegistry.register({
      manifest: { ...baseManifest, id: "registry-generation" as AdapterId },
      source: { kind: "generation", generationId: "generation-alpha2", packageName: "registry-generation", entryPoint: "fixture://generation" },
      enabled: true,
    });
    const server = await fixture.startServer();
    const response = await fetch(`${server.origin}/v1/adapters/registry`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      adapters: [
        { manifest: { id: "dsh-alpha2" }, source: { kind: "generation" } },
        { manifest: { id: "dsh-rc1" }, source: { kind: "generation" } },
        { manifest: { id: "dsh-rc2" }, source: { kind: "generation" } },
        { manifest: { id: "registry-generation" }, source: { kind: "generation" } },
        { manifest: { id: "registry-local" }, source: { kind: "local" } },
        { manifest: { id: "registry-npm" }, source: { kind: "npm" } },
      ],
    });
  });
});


describe("Built-in Adapter registration and runtime composition", () => {
  const cases = [
    { adapter: alpha2Adapter, version: "0.1.2-alpha.2", capability: "sessionPersistence" },
    { adapter: rc1Adapter, version: "0.1.2-rc.1", capability: "sessionPersistence" },
    { adapter: rc2Adapter, version: "0.1.1-rc.2", capability: "legacySessionPersistence" },
  ];

  it.each(cases)("selects $version using its RPC worker and resolves the same in-process implementation", async ({ adapter, version, capability }) => {
    const fixture = await createEngineFixture(`adapter-selection-${adapter.manifest.id}`);
    cleanups.push(fixture.cleanupAll);
    const registry = fixture.engine.adapterRegistry;
    expect(registry.host.factory).toBeInstanceOf(NodeAdapterWorkerFactory);
    const inProcessProbe = vi.spyOn(adapter, "probe");
    try {
      const selection = await registry.select({ environment: {
        dshVersion: version,
        packageVersions: { "@deepseek-ai/dsh-session": version, "@deepseek-ai/dsh-session-persistence": version },
        runtimeCapabilities: [capability],
      } });
      expect(selection).toMatchObject({ adapterId: adapter.manifest.id, reason: "verified", probe: { status: "verified" } });
      expect(inProcessProbe).not.toHaveBeenCalled();
      expect(registry.resolveRuntimeAdapter(selection.adapterId)).toBe(adapter);
      expect(fixture.engine.resolveProjectionAdapter(selection.adapterId)).toBe(adapter);
      const lifecycle = fixture.engine.projectionLifecycleFactory({ adapterId: selection.adapterId, bridge: {} as never });
      expect(lifecycle.adapter).toBe(adapter);
      // RC1 decorates the canonical source to restore its lifecycle evidence.
      // Verify the source contract, rather than requiring object identity.
      const sourceRun = { id: "synthetic-source-probe", branchId: "main" } as never;
      expect(await lifecycle.source.load(sourceRun)).toEqual(await fixture.engine.canonicalProjectionSource.load(sourceRun));
      expect(Object.keys(selection.registration).sort()).toEqual(["enabled", "manifest", "source"]);
    } finally {
      inProcessProbe.mockRestore();
    }
  });

  it("preserves exact RC1 rejection, diagnostic probing and RC2 broker protocol rejection", async () => {
    const fixture = await createEngineFixture("adapter-selection-rejection");
    cleanups.push(fixture.cleanupAll);
    const registry = fixture.engine.adapterRegistry;
    const environment = { dshVersion: "0.1.2-rc.1", packageVersions: {}, runtimeCapabilities: ["sessionPersistence"] };
    await expect(registry.select({ environment, pinnedAdapterId: rc1Adapter.manifest.id })).rejects.toThrow("Pinned Adapter is unavailable");
    // Alpha2 probing deliberately reports unverified related builds for diagnostics.
    const compatible = await registry.select({ environment: { ...environment, dshVersion: "0.1.2-alpha.99" } });
    expect(compatible).toMatchObject({ adapterId: alpha2Adapter.manifest.id, probe: { status: "compatible" } });
    await expect(registry.select({ environment: { dshVersion: "unknown", packageVersions: {}, runtimeCapabilities: [] } }))
      .rejects.toThrow("No Adapter passed");
    await expect(fixture.engine.runtimeBroker.prepareRun({
      schemaVersion: 1, client: { kind: "launcher", id: "fixture-client" }, runtimeClientId: "fixture-runtime",
      instanceId: "fixture", profileId: "web", dshVersion: "0.1.1-rc.2",
      maintenanceEndpoint: "http://127.0.0.1:41781", branchId: "main" as BranchId,
      environment: { packageVersions: { "@deepseek-ai/dsh-session": "0.1.1-rc.2" }, runtimeCapabilities: ["legacySessionPersistence"] },
      pinnedAdapterId: rc2Adapter.manifest.id, projectSelection: { kind: "all" },
    })).rejects.toThrow("Runtime Broker event/flush protocol is not available for adapter dsh-rc2");
  });

  it("applies registration changes to both composition resolvers", async () => {
    const fixture = await createEngineFixture("adapter-resolution-replacement");
    cleanups.push(fixture.cleanupAll);
    const registry = fixture.engine.adapterRegistry;
    const registration = registry.list().find((item) => item.manifest.id === alpha2Adapter.manifest.id)!;
    const replacement = { ...alpha2Adapter };
    await registry.register(registration, replacement);
    expect(fixture.engine.resolveProjectionAdapter(registration.manifest.id)).toBe(replacement);
    expect(fixture.engine.projectionLifecycleFactory({ adapterId: registration.manifest.id, bridge: {} as never }).adapter).toBe(replacement);
    await registry.register({ ...registration, enabled: false }, replacement);
    expect(fixture.engine.resolveProjectionAdapter(registration.manifest.id)).toBeUndefined();
    expect(() => fixture.engine.projectionLifecycleFactory({ adapterId: registration.manifest.id, bridge: {} as never }))
      .toThrow("Unsupported built-in projection adapter");
    expect(() => fixture.engine.projectionLifecycleFactory({ adapterId: "missing" as AdapterId, bridge: {} as never }))
      .toThrow("Unsupported built-in projection adapter");
  });
});
