import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { FakeWriteAdapter } from "@linmu/dsh-session-test-support";

import { AppendOnlyJournal, TransactionRecovery } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("TransactionRecovery", () => {
  it("verifies an interrupted applying transaction without replaying commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-recovery-"));
    roots.push(root);
    const repository = new SqliteSessionRepository(
      openMaintenanceDatabase(join(root, "metadata.sqlite")),
      new ZstdContentObjectStore(root),
    );
    const plan = createSyncPlan(appendOnlyPlanFixture("2026-08-27T00:00:00.000Z"));
    await repository.savePlan(plan);
    await repository.createTransaction({
      id: "tx-interrupted",
      planId: plan.id,
      planHash: plan.hash,
      platform: "dsh",
      instanceId: "dsh-fixture",
      rootIdentity: "fixture-root",
      adapterContract: plan.adapterContracts[0]!,
      status: "applying",
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    const adapter = new FakeWriteAdapter();
    const recovery = new TransactionRecovery({
      stateRoot: root,
      repository,
      adapters: new Map([["dsh", adapter]]),
    });
    const result = await recovery.recover("tx-interrupted");
    expect(result.status).toBe("completed");
    expect(adapter.calls).toEqual(["verify"]);
    repository.close();
  });

  it("fails closed when SQLite contains a step missing from the durable journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-recovery-disagree-"));
    roots.push(root);
    const repository = new SqliteSessionRepository(
      openMaintenanceDatabase(join(root, "metadata.sqlite")),
      new ZstdContentObjectStore(root),
    );
    const plan = createSyncPlan(appendOnlyPlanFixture("2026-08-27T00:00:00.000Z"));
    await repository.savePlan(plan);
    await repository.createTransaction({
      id: "tx-disagree",
      planId: plan.id,
      planHash: plan.hash,
      platform: "dsh",
      instanceId: "dsh-fixture",
      rootIdentity: "fixture-root",
      adapterContract: plan.adapterContracts[0]!,
      status: "prepared",
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    const path = join(root, "transactions", "tx-disagree", "journal.jsonl");
    const journal = new AppendOnlyJournal(path);
    const first = await journal.append({
      transactionId: "tx-disagree",
      status: "prepared",
      step: "created",
      at: "2026-08-27T00:00:00.000Z",
      data: {},
    });
    await repository.recordTransactionStep({ step: first });
    const second = await journal.append({
      transactionId: "tx-disagree",
      status: "applying",
      step: "commit-started",
      at: "2026-08-27T00:00:01.000Z",
      data: {},
    });
    await repository.recordTransactionStep({ step: second });
    const [firstLine] = (await readFile(path, "utf8")).trimEnd().split("\n");
    await writeFile(path, `${firstLine}\n`, "utf8");

    const adapter = new FakeWriteAdapter();
    const recovery = new TransactionRecovery({
      stateRoot: root,
      repository,
      adapters: new Map([["dsh", adapter]]),
    });
    await expect(recovery.recover("tx-disagree")).resolves.toMatchObject({
      status: "manual-review",
    });
    expect(adapter.calls).toEqual([]);
    expect((await repository.getTransaction("tx-disagree"))?.errorCode).toBe("OBJECT_CORRUPT");
    repository.close();
  });
});
