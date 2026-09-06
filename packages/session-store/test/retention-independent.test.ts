import { mkdir, writeFile, readFile, access, utimes, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { retentionFixture, NOW } from "./retention-fixture.js";
import {
  RetentionExecutor,
  RetentionRepository,
  openMaintenanceDatabase,
  planRetention,
  DEFAULT_RETENTION_POLICY,
} from "../src/index.js";
import { MaintenanceWriteCoordinator } from "../src/write-coordinator.js";
import { RetentionService } from "../../../apps/engine/src/retention-service.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await retentionFixture(),
    writes = MaintenanceWriteCoordinator.acquire(f.root, "engine");
  let now = NOW;
  cleanup.push(async () => {
    await writes.close();
    await f.close();
  });
  const executor = (fault?: ConstructorParameters<typeof RetentionExecutor>[0]["fault"]) =>
    new RetentionExecutor({
      repository: f.repository,
      writes,
      now: () => now,
      executionEnabled: true,
      ...(fault ? { fault } : {}),
    });
  const preview = async () =>
    planRetention(await f.repository.capture(now), { ...DEFAULT_RETENTION_POLICY, cacheTargetBytes: 0 });
  return {
    ...f,
    writes,
    executor,
    preview,
    setNow: (v: string) => {
      now = v;
    },
  };
}
async function flatFixture() {
  const f = await fixture(),
    objectId = await f.addVersion("external-only", "sole retained snapshot body");
  const first = await f.external("candidate-0");
  f.database.exec(
    "UPDATE logical_sessions SET head_version_id=NULL,canonical_version_id=NULL; DELETE FROM session_versions",
  );
  const paths = [first];
  for (let i = 1; i < 4; i++) paths.push(await f.external(`candidate-${i}`));
  const resources = [];
  for (let i = 0; i < 4; i++) {
    const path = paths[i]!;
    await writeFile(
      `${path}.manifest.json`,
      JSON.stringify({
        schemaVersion: 1,
        candidatePath: path,
        candidateDigest: `sha256:${createHash("sha256")
          .update(await readFile(path))
          .digest("hex")}`,
      }),
    );
    resources.push(
      await new RetentionService({
        repository: f.repository,
        writes: f.writes,
        clock: () => `2026-09-0${i + 1}T00:00:00.000Z`,
        executionEnabled: true,
      }).registerFlatCandidate(`candidate-${i}`),
    );
  }
  const hash = objectId.slice(7);
  await utimes(
    join(f.root, "objects/sha256", hash.slice(0, 2), `${hash.slice(2)}.zst`),
    new Date("2026-08-01"),
    new Date("2026-08-01"),
  );
  const plan = await f.preview();
  expect(plan.blockers).toEqual([]);
  expect(plan.items.filter((i) => i.executable).map((i) => i.id)).toEqual([resources[0]!.id]);
  return { ...f, objectId, paths, resources, plan };
}

it("P1 rejects reverse object namespace registration into an existing resource", async () => {
  const f = await fixture(),
    c = await f.resource("cache", "container");
  await expect(f.repository.registerRoot("nested-objects", c.path, "objects")).rejects.toThrow();
  expect(f.repository.roots().some((r) => r.id === "nested-objects")).toBe(false);
});

it("P1 rejects an existing resource within a registered object namespace without a source", async () => {
  const f = await fixture(),
    c = await f.resource("cache", "objects/contained-cache");
  await expect(f.repository.registerRoot("standalone-object-store", c.root.path, "objects")).rejects.toThrow();
});

it("P2 blocks a nested unknown sibling beside the exact registered resource", async () => {
  const f = await fixture(),
    c = await f.resource("cache", "group/known"),
    old = "2026-09-01T00:00:00.000Z";
  await writeFile(
    join(c.path, "projection-cache-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      cacheKey: c.entry.id,
      adapterId: "adapter",
      adapterFingerprint: "digest",
      configurationDigest: "configuration",
      lastAppliedRevision: 0,
      sessions: [],
      workspaces: [],
      createdAt: old,
      updatedAt: old,
    }),
  );
  f.repository.registerResource({ ...c.entry, lastUsedAt: old });
  await mkdir(join(c.root.path, "group/unknown"));
  await writeFile(join(c.root.path, "group/unknown/recovery.json"), "{}");
  const plan = await f.preview();
  expect(plan.blockers.some((b) => b.source.includes("group/unknown"))).toBe(true);
  expect(plan.items.find((i) => i.id === c.entry.id)?.executable).toBe(false);
  await expect(f.executor().quarantine(plan)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
});

it("flat main-only quarantine crash retains reference evidence before recovery", async () => {
  const f = await flatFixture();
  let first = true;
  const e = f.executor((stage) => {
    if (stage === "after-quarantine-move" && first) {
      first = false;
      throw Error("synthetic main moved crash");
    }
  });
  await expect(e.quarantine(f.plan)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
  await expect(access(f.paths[0]!)).rejects.toThrow();
  await access(`${f.paths[0]}.manifest.json`);
  const inventory = await f.repository.capture(NOW),
    plan = planRetention(inventory);
  expect(inventory.references.some((r) => r.source === "candidate-0" && r.targetId === f.objectId)).toBe(true);
  expect(plan.items.find((i) => i.id === `state:${f.objectId}`)?.disposition).toBe("protected");
});

it("flat main-only crash resumes then restores both members and shared object", async () => {
  const f = await flatFixture();
  let first = true;
  await expect(
    f
      .executor((stage) => {
        if (stage === "after-quarantine-move" && first) {
          first = false;
          throw Error("synthetic crash");
        }
      })
      .quarantine(f.plan),
  ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
  const batch = await f.executor().quarantine(f.plan);
  expect(batch.items[0]?.state).toBe("quarantined");
  expect(
    (await f.repository.capture(NOW)).references.some((r) => r.source === "candidate-0" && r.targetId === f.objectId),
  ).toBe(true);
  expect((await f.executor().restore(batch.id)).items[0]?.state).toBe("restored");
  await access(f.paths[0]!);
  await access(`${f.paths[0]}.manifest.json`);
  expect(Buffer.from(await f.objects.get(f.objectId)).toString()).toBe("sole retained snapshot body");
});

it("flat partial purge retries after executor restart and never unlinks shared objects", async () => {
  const f = await flatFixture(),
    batch = await f.executor().quarantine(f.plan);
  f.setNow("2026-09-09T12:00:00.000Z");
  let first = true;
  await expect(
    f
      .executor((stage) => {
        if (stage === "after-unlink" && first) {
          first = false;
          throw Error("synthetic partial unlink");
        }
      })
      .purge(batch.id),
  ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
  expect(f.executor().journal.get(batch.id)?.items[0]?.state).toBe("purging");
  expect((await f.executor().purge(batch.id)).items[0]?.state).toBe("purged");
  expect(Buffer.from(await f.objects.get(f.objectId)).toString()).toBe("sole retained snapshot body");
});

it("flat unknown companion blocks release and leaves companion and shared object intact", async () => {
  const f = await flatFixture(),
    batch = await f.executor().quarantine(f.plan);
  f.setNow("2026-09-09T12:00:00.000Z");
  const extra = join(f.root, batch.items[0]!.quarantinePath, "candidate-0.sqlite.unknown");
  await writeFile(extra, "unknown owner bytes");
  await expect(f.executor().purge(batch.id)).rejects.toThrow();
  expect(await readFile(extra, "utf8")).toBe("unknown owner bytes");
  expect(Buffer.from(await f.objects.get(f.objectId)).toString()).toBe("sole retained snapshot body");
});

it("flat interrupted restore resumes from persisted journal after database and owner reopen", async () => {
  const f = await flatFixture(),
    batch = await f.executor().quarantine(f.plan);
  let first = true;
  await expect(
    f
      .executor((stage) => {
        if (stage === "after-restore-move" && first) {
          first = false;
          throw Error("synthetic main restored crash");
        }
      })
      .restore(batch.id),
  ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
  expect(
    (await f.repository.capture(NOW)).references.some((r) => r.source === "candidate-0" && r.targetId === f.objectId),
  ).toBe(true);
  await f.writes.close();
  f.database.close();
  cleanup.pop();
  const db = openMaintenanceDatabase(join(f.root, "metadata.sqlite")),
    writes = MaintenanceWriteCoordinator.acquire(f.root, "engine");
  cleanup.push(async () => {
    await writes.close();
    db.close();
    expect(await readFile(join(f.root, "SYNTHETIC-ONLY.txt"), "utf8")).toContain("Synthetic");
    await rm(f.root, { recursive: true, force: true });
  });
  const repo = new RetentionRepository(db, join(f.root, "metadata.sqlite")),
    executor = new RetentionExecutor({ repository: repo, writes, executionEnabled: true, now: () => NOW });
  expect((await executor.restore(batch.id)).items[0]?.state).toBe("restored");
  await access(f.paths[0]!);
  await access(`${f.paths[0]}.manifest.json`);
  expect(
    (await repo.capture(NOW)).references.some((r) => r.source === "candidate-0" && r.targetId === f.objectId),
  ).toBe(true);
});

it("flat interrupted purge resumes from persisted journal after database and owner reopen", async () => {
  const f = await flatFixture(),
    batch = await f.executor().quarantine(f.plan);
  f.setNow("2026-09-09T12:00:00.000Z");
  let first = true;
  await expect(
    f
      .executor((stage) => {
        if (stage === "after-unlink" && first) {
          first = false;
          throw Error("synthetic partial purge");
        }
      })
      .purge(batch.id),
  ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
  await f.writes.close();
  f.database.close();
  cleanup.pop();
  const db = openMaintenanceDatabase(join(f.root, "metadata.sqlite")),
    writes = MaintenanceWriteCoordinator.acquire(f.root, "engine");
  cleanup.push(async () => {
    await writes.close();
    db.close();
    expect(await readFile(join(f.root, "SYNTHETIC-ONLY.txt"), "utf8")).toContain("Synthetic");
    await rm(f.root, { recursive: true, force: true });
  });
  const executor = new RetentionExecutor({
    repository: new RetentionRepository(db, join(f.root, "metadata.sqlite")),
    writes,
    executionEnabled: true,
    now: () => "2026-09-09T12:00:00.000Z",
  });
  expect((await executor.purge(batch.id)).items[0]?.state).toBe("purged");
  expect(Buffer.from(await f.objects.get(f.objectId)).toString()).toBe("sole retained snapshot body");
});

it("flat unknown file introduced after partial purge blocks restart retry without deleting it", async () => {
  const f = await flatFixture(),
    batch = await f.executor().quarantine(f.plan);
  f.setNow("2026-09-09T12:00:00.000Z");
  let first = true;
  await expect(
    f
      .executor((stage) => {
        if (stage === "after-unlink" && first) {
          first = false;
          throw Error("synthetic partial purge");
        }
      })
      .purge(batch.id),
  ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
  const extra = join(f.root, batch.items[0]!.quarantinePath, "candidate-0.sqlite.unknown");
  await writeFile(extra, "unknown owner bytes after interruption");
  await f.writes.close();
  f.database.close();
  cleanup.pop();
  const db = openMaintenanceDatabase(join(f.root, "metadata.sqlite")),
    writes = MaintenanceWriteCoordinator.acquire(f.root, "engine");
  cleanup.push(async () => {
    await writes.close();
    db.close();
    expect(await readFile(join(f.root, "SYNTHETIC-ONLY.txt"), "utf8")).toContain("Synthetic");
    await rm(f.root, { recursive: true, force: true });
  });
  const executor = new RetentionExecutor({
    repository: new RetentionRepository(db, join(f.root, "metadata.sqlite")),
    writes,
    executionEnabled: true,
    now: () => "2026-09-09T12:00:00.000Z",
  });
  await expect(executor.purge(batch.id)).rejects.toMatchObject({ code: "PLAN_STALE" });
  expect(await readFile(extra, "utf8")).toBe("unknown owner bytes after interruption");
  expect(Buffer.from(await f.objects.get(f.objectId)).toString()).toBe("sole retained snapshot body");
});
