import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
import type {
  AdapterId,
  BranchId,
  LeaseId,
  RunId,
} from "@linmu/dsh-session-contracts";
import {
  SqliteAdapterRegistryRepository,
  SqliteProjectionRunRepository,
  SqliteStatusEventRepository,
  openMaintenanceDatabase,
} from "@linmu/dsh-session-store";

import {
  MemoryStatusEventAdapter,
  SqliteStatusEventAdapter,
  StatusLog,
  type StatusEventAdapter,
} from "../src/index.js";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const at = "2026-08-31T00:00:00.000Z";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-sm-status-log-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function sqliteAdapter(): Promise<StatusEventAdapter> {
  const root = await temporaryRoot();
  const database = openMaintenanceDatabase(join(root, "metadata.sqlite"));
  databases.push(database);
  const adapters = new SqliteAdapterRegistryRepository(database);
  await adapters.upsertRegistration({
    manifest: {
      schemaVersion: 1,
      id: "adapter-status" as AdapterId,
      displayName: "Status fixture",
      adapterApiVersion: 1,
      packageVersion: "1.0.0",
      testedDshVersions: ["0.1.2-alpha.2"],
      declaredDshRange: "*",
      capabilities: [],
    },
    packageLocation: "fixture://status",
    enabled: true,
    registeredAt: at,
    updatedAt: at,
  });
  await new SqliteProjectionRunRepository(database).createProjectionRun({
    schemaVersion: 1,
    id: "run-status" as RunId,
    leaseId: "lease-status" as LeaseId,
    branchId: "main" as BranchId,
    instanceId: "launcher-status",
    profileId: "profile-status",
    dshVersion: "0.1.2-alpha.2",
    adapterId: "adapter-status" as AdapterId,
    state: "running",
    startedAt: at,
    heartbeatAt: at,
    checkpointId: null,
  });
  return new SqliteStatusEventAdapter(new SqliteStatusEventRepository(database));
}

const factories: ReadonlyArray<readonly [string, () => Promise<StatusEventAdapter>]> = [
  ["memory", async () => new MemoryStatusEventAdapter()],
  ["sqlite", sqliteAdapter],
];

for (const [name, factory] of factories) {
  describe(`StatusLog (${name})`, () => {
    it("persists paired terminal events and publishes the same event", async () => {
      const adapter = await factory();
      let id = 0;
      let tick = 0;
      const log = new StatusLog(adapter, {
        idFactory: (kind) => `${kind}-${++id}`,
        clock: () => `2026-08-31T00:00:0${tick++}.000Z`,
      });
      const controller = new AbortController();
      const iterator = log.subscribe({ runId: "run-status" as RunId }, controller.signal)[Symbol.asyncIterator]();
      const pending = iterator.next();
      const started = await log.start({
        runId: "run-status" as RunId,
        leaseId: "lease-status" as LeaseId,
        profileId: "profile-status",
        adapterId: "adapter-status" as AdapterId,
        dshVersion: "0.1.2-alpha.2",
        stage: "run.lease",
        logicalSessionId: null,
        nativeSessionId: null,
        operationId: null,
      });
      expect((await pending).value).toEqual(started.event);
      const succeeded = await log.succeed(started, { durationMs: 12 });
      const failedStart = await log.start({
        runId: "run-status" as RunId,
        leaseId: "lease-status" as LeaseId,
        profileId: "profile-status",
        adapterId: "adapter-status" as AdapterId,
        dshVersion: "0.1.2-alpha.2",
        stage: "projection.materialize",
        logicalSessionId: null,
        nativeSessionId: null,
        operationId: null,
      });
      const failed = await log.fail(failedStart, { errorCode: "CATALOG_DIGEST_MISMATCH" });
      controller.abort();

      const events = (await log.list({ runId: "run-status" as RunId })).items;
      expect(events.map((event) => event.state)).toEqual([
        "started",
        "succeeded",
        "started",
        "failed",
      ]);
      expect(succeeded.parentEventId).toBe(started.event.id);
      expect(succeeded.spanId).toBe(started.event.spanId);
      expect(failed.parentEventId).toBe(failedStart.event.id);
      expect(failed.errorCode).toBe("CATALOG_DIGEST_MISMATCH");
    });

    it("does not accept raw detail, prompts or tokens in persistent events", async () => {
      const adapter = await factory();
      const log = new StatusLog(adapter, {
        idFactory: (kind) => `${kind}-redaction`,
        clock: () => at,
      });
      const input = {
        runId: "run-status" as RunId,
        leaseId: "lease-status" as LeaseId,
        profileId: "profile-status",
        adapterId: "adapter-status" as AdapterId,
        dshVersion: "0.1.2-alpha.2",
        stage: "runtime.persistence.attach" as const,
        logicalSessionId: null,
        nativeSessionId: null,
        operationId: null,
        prompt: "do not persist this prompt",
        token: "secret-token",
        detail: "raw body",
      };
      const started = await log.start(input);
      const serialized = JSON.stringify((await log.list({ runId: "run-status" as RunId })).items);
      expect(serialized).not.toContain("prompt");
      expect(serialized).not.toContain("secret-token");
      expect(serialized).not.toContain("raw body");
      await expect(log.start({
        ...input,
        diagnosticDetailRef: "Bearer secret-token",
      })).rejects.toThrow(/diagnostic detail reference/iu);
      await expect(log.fail(started, {
        errorCode: "secret token body",
      })).rejects.toThrow(/machine error code/iu);
    });
  });
}
