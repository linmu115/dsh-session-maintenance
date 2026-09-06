import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DEFAULT_RETENTION_POLICY } from "../src/index.js";
import { MaintenanceWriteCoordinator } from "../src/write-coordinator.js";
import { RetentionService } from "../../../apps/engine/src/retention-service.js";
import { NOW, retentionFixture } from "./retention-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
const LATER = "2026-09-09T12:00:00.000Z";

async function fixture() {
  const f = await retentionFixture();
  const writes = MaintenanceWriteCoordinator.acquire(f.root, "engine");
  cleanup.push(async () => {
    await writes.close();
    await f.close();
  });
  let now = NOW;
  const service = new RetentionService({
    repository: f.repository,
    writes,
    clock: () => now,
    executionEnabled: true,
  });
  const caches = join(f.root, "projection-caches");
  await mkdir(caches);
  await service.registerRoot({ id: "caches", path: caches, purpose: "caches" });
  const path = join(caches, "adapter", "configuration", "cache-key");
  const payload = join(path, "payload.json");
  const create = async (generation: string) => {
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "projection-cache-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        cacheKey: "cache-key",
        adapterId: "adapter",
        adapterFingerprint: "digest",
        configurationDigest: "configuration",
        lastAppliedRevision: 0,
        sessions: [],
        workspaces: [],
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    await writeFile(payload, generation);
    const discovered = await service.discover();
    expect(discovered.unknownPaths).toEqual([]);
    expect(discovered.registeredResourceIds).toHaveLength(1);
    return discovered.registeredResourceIds[0]!;
  };
  const quarantine = async (id: string) => {
    const plan = await service.preview({ ...DEFAULT_RETENTION_POLICY, cacheTargetBytes: 0 });
    expect(plan.blockers).toEqual([]);
    expect(plan.items.find((item) => item.id === id)).toMatchObject({ executable: true });
    return service.execute(plan.id);
  };
  return {
    ...f,
    service,
    create,
    quarantine,
    payload,
    path,
    setNow: () => {
      now = LATER;
    },
  };
}

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it("discovers a new physical cache generation during quarantine without rebinding or overwriting the old one", async () => {
  const f = await fixture();
  const originalId = await f.create("original");
  const original = await f.quarantine(originalId);
  const replacementId = await f.create("replacement");
  expect(replacementId).not.toBe(originalId);
  expect(f.service.registry().resources).toHaveLength(2);
  expect(f.service.registry().resources.find((entry) => entry.id === originalId)).toMatchObject({
    state: "quarantined",
    relativePath: original.items[0]!.quarantinePath,
  });
  await writeFile(f.payload, "replacement updated");
  expect((await f.service.discover()).registeredResourceIds).toEqual([]);
  await expect(f.service.restore(original.id)).rejects.toMatchObject({ code: "PLAN_STALE" });
  expect(await readFile(f.payload, "utf8")).toBe("replacement updated");
  f.setNow();
  expect((await f.service.purge(original.id)).items[0]?.state).toBe("purged");
  expect(await readFile(f.payload, "utf8")).toBe("replacement updated");
  const replacement = await f.quarantine(replacementId);
  expect(replacement.items).toHaveLength(1);
  expect(replacement.items[0]?.resourceId).toBe(replacementId);
  await f.service.restore(replacement.id);
  expect(await readFile(f.payload, "utf8")).toBe("replacement updated");
  expect(f.service.listBatches().find((entry) => entry.id === original.id)?.items[0]).toMatchObject(
    {
      resourceId: originalId,
      state: "purged",
    },
  );
});

it("discovers and governs a cache rebuilt at the same path after its previous generation was purged", async () => {
  const f = await fixture();
  const originalId = await f.create("original");
  const original = await f.quarantine(originalId);
  f.setNow();
  await f.service.purge(original.id);
  const replacementId = await f.create("rebuilt after purge");
  expect(replacementId).not.toBe(originalId);
  expect((await f.service.discover()).registeredResourceIds).toEqual([]);
  expect(f.service.registry().resources.find((entry) => entry.id === originalId)?.state).toBe(
    "purged",
  );
  const replacement = await f.quarantine(replacementId);
  expect(replacement.items[0]?.resourceId).toBe(replacementId);
  await f.service.restore(replacement.id);
  expect(await readFile(f.payload, "utf8")).toBe("rebuilt after purge");
});

it("traverses only known journal ancestors and still blocks an unknown sibling beside a moved cache", async () => {
  const f = await fixture();
  const originalId = await f.create("original");
  const original = await f.quarantine(originalId);
  const unknown = join(dirname(f.path), "unknown");
  await mkdir(unknown);
  f.setNow();
  const plan = await f.service.preview({ ...DEFAULT_RETENTION_POLICY, cacheTargetBytes: 0 });
  expect(plan.blockers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "unregistered",
        source: "caches:adapter/configuration/unknown",
      }),
    ]),
  );
  await expect(f.service.purge(original.id)).rejects.toMatchObject({ code: "PLAN_STALE" });
  await rmdir(unknown);
  expect((await f.service.purge(original.id)).items[0]?.state).toBe("purged");
});
