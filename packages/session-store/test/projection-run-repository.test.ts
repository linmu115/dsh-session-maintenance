import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
import type {
  AdapterId,
  BranchId,
  LeaseId,
  LogicalSessionId,
  NativeSessionId,
  OperationId,
  ProjectionOperationReceipt,
  ProjectionRun,
  RunId,
  StatusEventV1,
  StatusSpanId,
} from "@linmu/dsh-session-contracts";

import {
  SqliteAdapterRegistryRepository,
  SqliteCanonicalRepository,
  SqliteProjectionRunRepository,
  SqliteStatusEventRepository,
  openMaintenanceDatabase,
} from "../src/index.js";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const at = "2026-08-31T00:00:00.000Z";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-sm-projection-run-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function run(id: string, leaseId: string, branchId = "main"): ProjectionRun {
  return {
    schemaVersion: 1,
    id: id as RunId,
    leaseId: leaseId as LeaseId,
    branchId: branchId as BranchId,
    instanceId: "launcher-alpha2",
    profileId: "profile-alpha2",
    dshVersion: "0.1.2-alpha.2",
    adapterId: "adapter-alpha2" as AdapterId,
    state: "preparing",
    startedAt: at,
    heartbeatAt: at,
    checkpointId: null,
  };
}

describe("projection runtime repositories", () => {
  it("rejects a second active writer lease on the same branch", async () => {
    const root = await temporaryRoot();
    const database = openMaintenanceDatabase(join(root, "metadata.sqlite"));
    databases.push(database);
    const adapters = new SqliteAdapterRegistryRepository(database);
    const runs = new SqliteProjectionRunRepository(database);
    await adapters.upsertRegistration({
      manifest: {
        schemaVersion: 1,
        id: "adapter-alpha2" as AdapterId,
        displayName: "Alpha2 fixture",
        adapterApiVersion: 1,
        packageVersion: "1.0.0",
        testedDshVersions: ["0.1.2-alpha.2"],
        declaredDshRange: ">=0.1.2-alpha.2",
        capabilities: ["session-persistence"],
      },
      packageLocation: "fixture://adapter-alpha2",
      enabled: true,
      registeredAt: at,
      updatedAt: at,
    });

    expect(await runs.createProjectionRun(run("run-main-1", "lease-main-1"))).toMatchObject({
      id: "run-main-1",
    });
    await expect(
      runs.createProjectionRun(run("run-main-2", "lease-main-2")),
    ).rejects.toThrow(/active|unique|lease/iu);
    await expect(
      runs.createProjectionRun(run("run-experiment-1", "lease-experiment-1", "experiment")),
    ).resolves.toMatchObject({ id: "run-experiment-1" });

    await runs.setProjectionRunState("run-main-1" as RunId, "closed");
    await expect(
      runs.createProjectionRun(run("run-main-2", "lease-main-2")),
    ).resolves.toMatchObject({ id: "run-main-2" });
  }, 15_000);

  it("keeps operation receipts idempotent and queries ordered status spans", async () => {
    const root = await temporaryRoot();
    const database = openMaintenanceDatabase(join(root, "metadata.sqlite"));
    databases.push(database);
    const adapters = new SqliteAdapterRegistryRepository(database);
    const canonical = new SqliteCanonicalRepository(database);
    const runs = new SqliteProjectionRunRepository(database);
    const statuses = new SqliteStatusEventRepository(database);
    await adapters.upsertRegistration({
      manifest: {
        schemaVersion: 1,
        id: "adapter-alpha2" as AdapterId,
        displayName: "Alpha2 fixture",
        adapterApiVersion: 1,
        packageVersion: "1.0.0",
        testedDshVersions: ["0.1.2-alpha.2"],
        declaredDshRange: ">=0.1.2-alpha.2",
        capabilities: ["session-persistence"],
      },
      packageLocation: "fixture://adapter-alpha2",
      enabled: true,
      registeredAt: at,
      updatedAt: at,
    });
    const projectionRun = run("run-status-1", "lease-status-1");
    await runs.createProjectionRun(projectionRun);
    await canonical.createCanonicalSession({
      schemaVersion: 1,
      id: "logical-runtime-1" as LogicalSessionId,
      authorityScope: "maintenance",
      originKind: "maintenance-native",
      headVersionId: null,
      title: "Runtime fixture",
      tags: [],
      archivedAt: null,
      tombstonedAt: null,
      createdAt: at,
      updatedAt: at,
    });
    await runs.upsertProjectionSession({
      schemaVersion: 1,
      runId: projectionRun.id,
      nativeSessionId: "native-runtime-1" as NativeSessionId,
      logicalSessionId: "logical-runtime-1" as LogicalSessionId,
      baseVersionId: null,
      mode: "maintenance-write",
      nativeRevision: 1,
      lastCommittedOperationId: null,
      derivedChildSessionId: null,
    });
    const receipt: ProjectionOperationReceipt = {
      schemaVersion: 1,
      operationId: "operation-runtime-1" as OperationId,
      runId: projectionRun.id,
      logicalSessionId: "logical-runtime-1" as LogicalSessionId,
      nativeSessionId: "native-runtime-1" as NativeSessionId,
      status: "committed",
      canonicalVersionId: null,
      projectionRevision: 2,
      committedAt: "2026-08-31T00:00:02.000Z",
    };
    await runs.saveOperationReceipt(receipt);
    await runs.saveOperationReceipt(receipt);
    expect(await runs.getOperationReceipt(receipt.operationId)).toEqual(receipt);

    const spanId = "span-append-1" as StatusSpanId;
    const statusEvents: StatusEventV1[] = [
      {
        schemaVersion: 1,
        id: "status-append-start" as StatusEventV1["id"],
        at: "2026-08-31T00:00:01.000Z",
        runId: projectionRun.id,
        leaseId: projectionRun.leaseId,
        profileId: projectionRun.profileId,
        adapterId: projectionRun.adapterId,
        dshVersion: projectionRun.dshVersion,
        stage: "session.append.commit",
        state: "started",
        logicalSessionId: receipt.logicalSessionId,
        nativeSessionId: receipt.nativeSessionId,
        operationId: receipt.operationId,
        parentEventId: null,
        spanId,
        errorCode: null,
        durationMs: null,
        diagnosticDetailRef: null,
      },
      {
        schemaVersion: 1,
        id: "status-append-success" as StatusEventV1["id"],
        at: "2026-08-31T00:00:02.000Z",
        runId: projectionRun.id,
        leaseId: projectionRun.leaseId,
        profileId: projectionRun.profileId,
        adapterId: projectionRun.adapterId,
        dshVersion: projectionRun.dshVersion,
        stage: "session.append.commit",
        state: "succeeded",
        logicalSessionId: receipt.logicalSessionId,
        nativeSessionId: receipt.nativeSessionId,
        operationId: receipt.operationId,
        parentEventId: "status-append-start" as StatusEventV1["id"],
        spanId,
        errorCode: null,
        durationMs: 1000,
        diagnosticDetailRef: null,
      },
    ];
    for (const event of statusEvents) await statuses.appendStatusEvent(event);

    expect((await statuses.listStatusEvents({ spanId })).items).toEqual(statusEvents);
    expect(
      (await statuses.listStatusEvents({
        runId: projectionRun.id,
        logicalSessionId: receipt.logicalSessionId,
        operationId: receipt.operationId,
        stage: "session.append.commit",
      })).items,
    ).toEqual(statusEvents);
  }, 15_000);
});
