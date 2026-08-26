import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSyncPlan } from "@linmu/dsh-session-domain";

import { appendOnlyPlanFixture } from "../../session-domain/test/plan-fixtures.js";
import {
  SqliteSessionRepository,
  ZstdContentObjectStore,
  openMaintenanceDatabase,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("sync plan persistence", () => {
  it("is idempotent and survives repository reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-plans-"));
    roots.push(root);
    const path = join(root, "metadata.sqlite");
    let database = openMaintenanceDatabase(path);
    let repository = new SqliteSessionRepository(database, new ZstdContentObjectStore(root));
    const plan = createSyncPlan(appendOnlyPlanFixture("2026-08-26T00:00:00.000Z"));

    await repository.savePlan(plan);
    await repository.savePlan(plan);
    expect(await repository.getPlan(plan.id)).toEqual(plan);
    repository.close();

    database = openMaintenanceDatabase(path);
    repository = new SqliteSessionRepository(database, new ZstdContentObjectStore(root));
    expect(await repository.getPlan(plan.id)).toEqual(plan);
    repository.close();
  });

  it("rejects malformed stored JSON and immutable collisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-plan-corrupt-"));
    roots.push(root);
    const database = openMaintenanceDatabase(join(root, "metadata.sqlite"));
    const repository = new SqliteSessionRepository(database, new ZstdContentObjectStore(root));
    const plan = createSyncPlan(appendOnlyPlanFixture("2026-08-26T00:00:00.000Z"));
    await repository.savePlan(plan);

    database.prepare("UPDATE sync_plans SET plan_json = ? WHERE id = ?").run("{", plan.id);
    await expect(repository.getPlan(plan.id)).rejects.toMatchObject({ code: "OBJECT_CORRUPT" });
    await expect(repository.savePlan(plan)).rejects.toMatchObject({ code: "VERSION_ID_COLLISION" });
    repository.close();
  });
});
