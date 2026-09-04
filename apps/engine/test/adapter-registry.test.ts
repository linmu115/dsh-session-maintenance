import { afterEach, describe, expect, it } from "vitest";
import type { AdapterId } from "@linmu/dsh-session-contracts";

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
