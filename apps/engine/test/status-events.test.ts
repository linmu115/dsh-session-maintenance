import { afterEach, describe, expect, it } from "vitest";
import type { AdapterId, BranchId, LeaseId, RunId } from "@linmu/dsh-session-contracts";
import { SqliteAdapterRegistryRepository, SqliteProjectionRunRepository } from "@linmu/dsh-session-store";

import { createEngineFixture } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("status event API and SSE", () => {
  it("streams the same event that was durably queried", async () => {
    const fixture = await createEngineFixture("status-events-api");
    cleanups.push(fixture.cleanupAll);
    const adapters = new SqliteAdapterRegistryRepository(fixture.engine.repository.database);
    await adapters.upsertRegistration({
      manifest: {
        schemaVersion: 1,
        id: "adapter-status-api" as AdapterId,
        displayName: "Status API fixture",
        adapterApiVersion: 1,
        packageVersion: "1.0.0",
        testedDshVersions: ["0.1.2-alpha.2"],
        declaredDshRange: "*",
        capabilities: [],
      },
      packageLocation: "fixture://status-api",
      enabled: true,
      registeredAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    });
    await new SqliteProjectionRunRepository(fixture.engine.repository.database).createProjectionRun({
      schemaVersion: 1,
      id: "run-status-api" as RunId,
      leaseId: "lease-status-api" as LeaseId,
      branchId: "main" as BranchId,
      instanceId: "launcher-status-api",
      profileId: "profile-status-api",
      dshVersion: "0.1.2-alpha.2",
      adapterId: "adapter-status-api" as AdapterId,
      state: "running",
      startedAt: "2026-08-31T00:00:00.000Z",
      heartbeatAt: "2026-08-31T00:00:00.000Z",
      checkpointId: null,
    });
    const server = await fixture.startServer();
    const stream = await fetch(`${server.origin}/v1/status-events/stream?runId=run-status-api`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const started = await fixture.engine.statusLog.start({
      runId: "run-status-api" as RunId,
      leaseId: "lease-status-api" as LeaseId,
      profileId: "profile-status-api",
      adapterId: "adapter-status-api" as AdapterId,
      dshVersion: "0.1.2-alpha.2",
      stage: "run.lease",
      logicalSessionId: null,
      nativeSessionId: null,
      operationId: null,
    });
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain(`data: ${JSON.stringify(started.event)}`);

    const queried = await fetch(`${server.origin}/v1/status-events?runId=run-status-api`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(queried.status).toBe(200);
    expect(await queried.json()).toEqual({ page: { items: [started.event] } });
    await reader.cancel();
  }, 15_000);
});
