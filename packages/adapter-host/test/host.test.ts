import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
import type { AdapterId, AdapterProbeResult, JsonValue } from "@linmu/dsh-session-contracts";
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
