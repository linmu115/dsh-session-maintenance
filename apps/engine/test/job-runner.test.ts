import { afterEach, describe, expect, it } from "vitest";

import { JobRunner } from "../src/jobs/job-runner.js";
import { JobStore } from "../src/jobs/job-store.js";
import { createEngineFixture } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("persistent scan job recovery", () => {
  it("requeues an interrupted scan once and fails unknown kinds", async () => {
    const fixture = await createEngineFixture("job-recovery");
    cleanups.push(fixture.cleanupAll);
    const store = new JobStore(fixture.engine.repository.database);
    const scan = store.createScan(["codex-fixture"]);
    fixture.engine.repository.database.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(scan.id);
    const now = "2026-08-26T00:00:00.000Z";
    fixture.engine.repository.database.prepare(
      "INSERT INTO jobs (id, status, request_json, result_json, created_at, updated_at) VALUES (?, 'running', ?, NULL, ?, ?)",
    ).run("job_unknown", JSON.stringify({ kind: "write" }), now, now);

    const runner = new JobRunner(fixture.engine, store);
    runner.start();
    const events = [];
    for await (const event of store.subscribe(scan.id)) events.push(event);
    expect(events.filter((event) => event.type === "queued")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("completed");
    expect(store.get("job_unknown")?.ref.status).toBe("failed");
    expect(store.listEvents("job_unknown").at(-1)).toMatchObject({ type: "failed", code: "RECOVERY_REQUIRED" });
  });
});
