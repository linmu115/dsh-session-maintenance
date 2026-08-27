import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SqliteSessionRepository,
  ZstdContentObjectStore,
  openMaintenanceDatabase,
} from "@linmu/dsh-session-store";
import { createSyncPlan } from "@linmu/dsh-session-domain";
import { appendOnlyPlanFixture } from "../../session-domain/test/plan-fixtures.js";

import { CheckpointService } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("CheckpointService", () => {
  it("reopens a named checkpoint and protects its completed transaction backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-checkpoint-"));
    roots.push(root);
    const path = join(root, "metadata.sqlite");
    let repository = new SqliteSessionRepository(
      openMaintenanceDatabase(path),
      new ZstdContentObjectStore(root),
    );
    const plan = createSyncPlan(appendOnlyPlanFixture("2026-08-27T00:00:00.000Z"));
    await repository.savePlan(plan);
    await repository.createTransaction({
      id: "tx-complete",
      planId: plan.id,
      planHash: plan.hash,
      platform: "dsh",
      instanceId: "dsh-fixture",
      rootIdentity: "fixture-root",
      adapterContract: plan.adapterContracts[0]!,
      status: "completed",
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:01.000Z",
    });
    await repository.saveBackupManifest({
      schemaVersion: 1,
      transactionId: "tx-complete",
      entries: [],
      createdAt: "2026-08-27T00:00:00.000Z",
      hash: "sha256:fixture-backup",
    });
    const service = new CheckpointService(repository);
    const created = await service.create({
      name: "stable DSH",
      description: "known-good fixture",
      refs: { canonical: "version-a" },
      backupTransactionIds: ["tx-complete"],
      createdBy: "test",
      createdAt: "2026-08-27T00:00:02.000Z",
    });
    expect(await service.create({
      name: "stable DSH",
      description: "known-good fixture",
      refs: { canonical: "version-a" },
      backupTransactionIds: ["tx-complete"],
      createdBy: "test",
      createdAt: "2026-08-27T00:00:02.000Z",
    })).toEqual(created);
    repository.close();

    repository = new SqliteSessionRepository(
      openMaintenanceDatabase(path),
      new ZstdContentObjectStore(root),
    );
    expect(await repository.getCheckpoint(created.id)).toEqual(created);
    expect(await repository.listBackupProtections()).toEqual([
      { transactionId: "tx-complete", reasons: ["checkpoint"] },
    ]);
    repository.close();
  });
});
