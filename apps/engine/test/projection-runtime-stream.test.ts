import { afterEach, describe, expect, it } from "vitest";
import type {
  AdapterId,
  BranchId,
  LeaseId,
  NativeSessionId,
  RunId,
} from "@linmu/dsh-session-contracts";
import { JsonProjectionDirectory, projectionRootFor } from "@linmu/dsh-session-projection-lifecycle";

import { createEngineFixture } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("projection runtime stream HTTP API", () => {
  it("streams an active run and returns a bounded unknown-session error before headers", async () => {
    const fixture = await createEngineFixture("projection-runtime-stream-http");
    cleanups.push(fixture.cleanupAll);
    const runId = "run-http-stream" as RunId;
    await fixture.engine.projectionRunRepository.createProjectionRun({
      schemaVersion: 1,
      id: runId,
      leaseId: "lease-http-stream" as LeaseId,
      branchId: "stream-http" as BranchId,
      instanceId: "alpha2-http",
      profileId: "web",
      dshVersion: "0.1.2-alpha.2",
      adapterId: "dsh-alpha2" as AdapterId,
      state: "preparing",
      startedAt: "2026-09-01T00:00:00.000Z",
      heartbeatAt: "2026-09-01T00:00:00.000Z",
      checkpointId: null,
    });
    const directory = new JsonProjectionDirectory(projectionRootFor(fixture.engine.projectionRuntimeRoot, runId));
    await directory.initialize();
    const nativeSessionId = "native-http-stream" as NativeSessionId;
    await directory.writeSession(nativeSessionId, {
      schemaVersion: 1,
      logicalSessionId: "logical-http-stream",
      updatedAt: "2026-09-01T00:00:00.000Z",
      title: "HTTP stream",
      header: { version: 0, id: nativeSessionId, createdAt: 0 },
      events: [{ type: "test/event", seq: 0, time: 0, data: { ok: true } }],
    });
    await directory.rebuildSessionCatalog(runId);
    const server = await fixture.startServer();
    const headers = { authorization: `Bearer ${server.token}` };

    const startup = await fetch(`${server.origin}/v1/projection-runs/${runId}/runtime/stream?hotLimit=1`, { headers });
    expect(startup.status).toBe(200);
    expect(startup.headers.get("content-type")).toContain("application/x-ndjson");
    expect((await startup.text()).trim().split("\n").map((frame) => JSON.parse(frame).type)).toEqual([
      "catalog-begin", "catalog-sessions", "catalog-end", "session-begin", "events", "session-end",
    ]);

    const unknown = await fetch(
      `${server.origin}/v1/projection-runs/${runId}/runtime/sessions/missing/stream`,
      { headers },
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: { code: "PROJECTION_SESSION_NOT_FOUND", message: "Projection session not found" },
    });
  });
});
