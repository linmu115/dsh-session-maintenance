import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
import type { AdapterId, AdapterProbeResult, AdapterRegistration, AdapterRegistrationRecord, AdapterRegistryRepository, AdapterVerificationRunRecord, DshSessionAdapterV1, JsonValue } from "@linmu/dsh-session-contracts";
import { SqliteAdapterRegistryRepository, openMaintenanceDatabase } from "@linmu/dsh-session-store";

import {
  AdapterHost,
  AdapterRegistry,
  type AdapterRpcWorker,
  type AdapterWorkerFactory,
} from "../src/index.js";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const at = "2026-08-31T00:00:00.000Z";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-sm-adapter-host-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function manifest(id: string) {
  return {
    schemaVersion: 1 as const,
    id: id as AdapterId,
    displayName: id,
    adapterApiVersion: 1 as const,
    packageVersion: "1.0.0",
    testedDshVersions: [],
    declaredDshRange: "<0.1.0",
    capabilities: ["session-persistence" as const],
  };
}

class FakeWorker implements AdapterRpcWorker {
  readonly result: AdapterProbeResult | Error;
  closed = false;

  constructor(result: AdapterProbeResult | Error) {
    this.result = result;
  }

  async request(method: string, _payload: JsonValue): Promise<JsonValue> {
    expect(method).toBe("probe");
    if (this.result instanceof Error) throw this.result;
    return this.result as unknown as JsonValue;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("Adapter Host and Registry", () => {
  it("isolates crashes and selects pinned, verified, then experimental candidates", async () => {
    const root = await temporaryRoot();
    const database = openMaintenanceDatabase(join(root, "metadata.sqlite"));
    databases.push(database);
    const workers: FakeWorker[] = [];
    const factory: AdapterWorkerFactory = {
      launch: async (registration) => {
        const status = registration.manifest.id === "verified" ? "verified"
          : registration.manifest.id === "experimental" ? "experimental"
            : "failed";
        const worker = new FakeWorker(status === "failed"
          ? new Error("simulated child process exit 17")
          : {
              status,
              manifest: registration.manifest,
              detectedDshVersion: "0.1.2-alpha.999",
              capabilities: registration.manifest.capabilities,
              issues: [],
            });
        workers.push(worker);
        return worker;
      },
    };
    let verification = 0;
    const registry = new AdapterRegistry({
      host: new AdapterHost(factory, { timeoutMs: 100 }),
      repository: new SqliteAdapterRegistryRepository(database),
      now: () => at,
      verificationId: () => `verification-${++verification}`,
    });
    await registry.register({
      manifest: manifest("verified"),
      source: { kind: "npm", packageName: "verified-package", entryPoint: "fixture://verified" },
      enabled: true,
    });
    await registry.register({
      manifest: manifest("experimental"),
      source: { kind: "generation", generationId: "generation-alpha2", packageName: "experimental-package", entryPoint: "fixture://experimental" },
      enabled: true,
    });
    await registry.register({
      manifest: manifest("crash"),
      source: { kind: "local", directory: root, entryPoint: "fixture://crash" },
      enabled: true,
    });
    const environment = {
      dshVersion: "0.1.2-alpha.999",
      packageVersions: {},
      runtimeCapabilities: ["sessionPersistence"],
    };

    await expect(registry.select({ environment })).resolves.toMatchObject({
      adapterId: "verified",
      reason: "verified",
    });
    await expect(registry.select({ environment, pinnedAdapterId: "experimental" as AdapterId })).resolves.toMatchObject({
      adapterId: "experimental",
      reason: "pinned",
      probe: { status: "experimental" },
    });
    expect(workers.every((worker) => worker.closed)).toBe(true);
    expect(
      database.prepare("SELECT status, result_json FROM adapter_verification_runs ORDER BY id").all(),
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "failed", result_json: expect.stringContaining("ADAPTER_PROCESS_FAILED") }),
      expect.objectContaining({ status: "experimental", result_json: expect.stringContaining("pinned") }),
      expect.objectContaining({ status: "verified", result_json: expect.stringContaining("verified") }),
    ]));
  });
});


describe("Adapter runtime bindings", () => {
  function fixture() {
    const registrations: AdapterRegistrationRecord[] = [];
    const verifications: AdapterVerificationRunRecord[] = [];
    const repository: AdapterRegistryRepository = {
      upsertRegistration: async (record) => { registrations.push(record); },
      saveVerificationRun: async (record) => { verifications.push(record); },
    };
    const registry = new AdapterRegistry({
      repository,
      host: new AdapterHost({ launch: async ({ manifest: adapterManifest }) => new FakeWorker({
        manifest: adapterManifest, status: "verified", detectedDshVersion: "fixture",
        capabilities: [], issues: [],
      }) }),
      now: () => at,
    });
    const registration: AdapterRegistration = {
      manifest: manifest("runtime-fixture"),
      source: { kind: "local", directory: "synthetic", entryPoint: "fixture://runtime" },
      enabled: true,
    };
    // No native operations are needed to exercise selection and binding ownership.
    const runtime = { manifest: registration.manifest } as DshSessionAdapterV1;
    return { repository, registrations, verifications, registry, registration, runtime };
  }

  it("uses a synthetic persistence port and keeps executable bindings out of registry DTOs", async () => {
    const { registry, registration, runtime, registrations, verifications } = fixture();
    await registry.register(registration, runtime);
    expect(registry.resolveRuntimeAdapter(registration.manifest.id)).toBe(runtime);
    expect(registry.resolveRuntimeAdapter("missing" as AdapterId)).toBeUndefined();
    expect(registry.list()).toEqual([registration]);
    expect(registrations).toEqual([{
      manifest: registration.manifest, packageLocation: "local:synthetic#fixture://runtime",
      enabled: true, registeredAt: at, updatedAt: at,
    }]);
    await registry.select({ environment: { dshVersion: "fixture", packageVersions: {}, runtimeCapabilities: [] } });
    expect(verifications.at(-1)?.result).toMatchObject({ adapterId: registration.manifest.id, reason: "verified" });
  });

  it("disables runtime resolution and clears stale bindings when a registration is replaced", async () => {
    const { registry, registration, runtime } = fixture();
    await registry.register(registration, runtime);
    await registry.register({ ...registration, enabled: false }, runtime);
    expect(registry.resolveRuntimeAdapter(registration.manifest.id)).toBeUndefined();
    await expect(registry.select({ environment: { dshVersion: "fixture", packageVersions: {}, runtimeCapabilities: [] } }))
      .rejects.toThrow("No Adapter passed");
    await registry.register(registration);
    expect(registry.resolveRuntimeAdapter(registration.manifest.id)).toBeUndefined();
    const replacement = { ...runtime };
    await registry.register(registration, replacement);
    expect(registry.resolveRuntimeAdapter(registration.manifest.id)).toBe(replacement);
  });

  it.each([
    { id: "other-adapter" as AdapterId },
    { packageVersion: "2.0.0" },
    { testedDshVersions: ["different-format"] },
  ])("rejects a mismatched runtime manifest without replacing the existing registration: %j", async (change) => {
    const { registry, registration, runtime, registrations } = fixture();
    await registry.register(registration, runtime);
    await expect(registry.register(registration, { ...runtime, manifest: { ...runtime.manifest, ...change } }))
      .rejects.toThrow("manifest does not match");
    expect(registry.resolveRuntimeAdapter(registration.manifest.id)).toBe(runtime);
    expect(registrations).toHaveLength(1);
  });

  it("does not publish a registration or binding when persistence fails", async () => {
    const { registry, repository, registration, runtime } = fixture();
    await registry.register(registration, runtime);
    repository.upsertRegistration = async () => { throw new Error("synthetic store failure"); };
    await expect(registry.register({ ...registration, enabled: false })).rejects.toThrow("synthetic store failure");
    expect(registry.list()).toEqual([registration]);
    expect(registry.resolveRuntimeAdapter(registration.manifest.id)).toBe(runtime);
  });
});
