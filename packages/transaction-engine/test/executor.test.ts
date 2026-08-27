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
import {
  FakeWriteAdapter,
  type FakeWriteAdapterOptions,
} from "@linmu/dsh-session-test-support";

import { ConfirmationService, TransactionExecutor } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

async function fixture(options: FakeWriteAdapterOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-sm-executor-"));
  roots.push(root);
  const repository = new SqliteSessionRepository(
    openMaintenanceDatabase(join(root, "metadata.sqlite")),
    new ZstdContentObjectStore(root),
  );
  const plan = createSyncPlan(appendOnlyPlanFixture("2026-08-27T00:00:00.000Z"));
  await repository.savePlan(plan);
  const adapter = new FakeWriteAdapter(options);
  const confirmation = new ConfirmationService(repository, {
    now: () => new Date("2026-08-27T00:00:00.000Z"),
    randomToken: () => "restore-secret",
  });
  const executor = new TransactionExecutor({
    stateRoot: root,
    repository,
    adapters: new Map([["dsh", adapter]]),
    instances: new Map([
      [
        "dsh-fixture",
        {
          id: "dsh-fixture",
          platform: "dsh",
          displayName: "fixture",
          root: join(root, "dsh-home"),
          platformVersion: "0.1.1-rc.2",
        },
      ],
    ]),
    readFingerprints: async () => plan.preconditions,
    now: () => new Date("2026-08-27T00:00:00.000Z"),
    idFactory: () => "tx-a",
    confirmationService: confirmation,
  });
  return { repository, plan, adapter, executor, confirmation };
}

describe("TransactionExecutor", () => {
  it("orders backup before commit, verifies, and is idempotent", async () => {
    const { repository, plan, adapter, executor } = await fixture();
    const first = await executor.apply({ planId: plan.id });
    const second = await executor.apply({ planId: plan.id });
    expect(first.status).toBe("completed");
    expect(second.id).toBe(first.id);
    expect(adapter.calls).toEqual(["probe", "prepare", "backup", "commit", "verify"]);
    expect((await repository.getTransaction(first.id))?.status).toBe("completed");
    repository.close();
  });

  it("restores exactly once when verification fails", async () => {
    const { repository, plan, adapter, executor } = await fixture({ verifyOk: false });
    const result = await executor.apply({ planId: plan.id });
    expect(result.status).toBe("restored");
    expect(adapter.calls).toEqual([
      "probe",
      "prepare",
      "backup",
      "commit",
      "verify",
      "restore",
    ]);
    repository.close();
  });

  it("rejects stale fingerprints before creating a platform mutation", async () => {
    const { repository, plan, adapter, executor } = await fixture();
    executor.readFingerprints = async () => [];
    await expect(executor.apply({ planId: plan.id })).rejects.toMatchObject({ code: "PLAN_STALE" });
    expect(adapter.calls).toEqual(["probe"]);
    repository.close();
  });

  it.each(["commit", "verify"] as const)(
    "restores once when the Adapter faults at %s after commit may have started",
    async (faultAt) => {
      const { repository, plan, adapter, executor } = await fixture({ faultAt });
      const result = await executor.apply({ planId: plan.id });
      expect(result.status).toBe("restored");
      expect(adapter.calls.filter((call) => call === "restore")).toHaveLength(1);
      repository.close();
    },
  );

  it("records restore failure without attempting restore twice", async () => {
    const { repository, plan, adapter, executor } = await fixture({
      verifyOk: false,
      faultAt: "restore",
    });
    const result = await executor.apply({ planId: plan.id });
    expect(result.status).toBe("restore-failed");
    expect(adapter.calls.filter((call) => call === "restore")).toHaveLength(1);
    repository.close();
  });

  it("never commits when backup fails", async () => {
    const { repository, plan, adapter, executor } = await fixture({ faultAt: "backup" });
    await expect(executor.apply({ planId: plan.id })).rejects.toThrow(/fake fault/iu);
    expect(adapter.calls).toEqual(["probe", "prepare", "backup"]);
    expect((await repository.getTransaction("tx-a"))?.status).toBe("manual-review");
    repository.close();
  });

  it("requires a scoped single-use confirmation for explicit restore", async () => {
    const { repository, plan, adapter, executor, confirmation } = await fixture();
    const completed = await executor.apply({ planId: plan.id });
    const issued = await confirmation.issue(await executor.restoreScope(completed.id));
    await expect(
      executor.restore({ transactionId: completed.id, confirmationToken: issued.token }),
    ).resolves.toMatchObject({ status: "restored" });
    expect(adapter.calls.filter((call) => call === "restore")).toHaveLength(1);
    await expect(
      executor.restore({ transactionId: completed.id, confirmationToken: issued.token }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    repository.close();
  });
});
