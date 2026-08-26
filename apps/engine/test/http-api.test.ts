import { afterEach, describe, expect, it } from "vitest";

import { MaintenanceClient } from "../../../packages/local-api-client/src/index.js";
import { windowsAclArgv } from "../src/http/server.js";
import { createEngineFixture, hashTree } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("authenticated loopback API", () => {
  it("authenticates bounded routes and streams scan jobs without platform writes", async () => {
    const fixture = await createEngineFixture("http");
    cleanups.push(fixture.cleanupAll);
    const before = await hashTree(fixture.codexHome);
    const server = await fixture.startServer();
    expect((await fetch(`${server.origin}/v1/health`)).status).toBe(200);
    expect((await fetch(`${server.origin}/v1/sessions`)).status).toBe(401);
    expect((await fetch(`${server.origin}/v1/sessions`, {
      headers: { authorization: `Bearer ${server.token}`, origin: "https://malicious.invalid" },
    })).status).toBe(403);

    const client = new MaintenanceClient({ origin: server.origin, token: server.token });
    const job = await client.scan(["codex-fixture"]);
    const events = [];
    for await (const event of client.subscribe(job.id)) events.push(event);
    expect(events.map((event) => event.type)).toEqual(["queued", "running", "progress", "progress", "completed"]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect((await client.listSessions()).items).toHaveLength(1);
    expect(await hashTree(fixture.codexHome)).toBe(before);

    const oversized = await fetch(`${server.origin}/v1/diffs`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(70_000) }),
    });
    expect(oversized.status).toBe(413);
    const pathInjection = await fetch(`${server.origin}/v1/jobs/scan`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: JSON.stringify({ instanceIds: ["codex-fixture"], root: "D:/forbidden" }),
    });
    expect(pathInjection.status).toBe(400);
    expect((await fetch(`${server.origin}/v1/plans/plan_x/apply`, {
      method: "POST", headers: { authorization: `Bearer ${server.token}` },
    })).status).toBe(501);
  });

  it("refuses non-loopback binding", async () => {
    const fixture = await createEngineFixture("loopback");
    cleanups.push(fixture.cleanupAll);
    await expect(fixture.startServer({ host: "0.0.0.0" })).rejects.toMatchObject({ code: "LOOPBACK_ONLY" });
  });

  it("constructs ACL arguments without a shell command string", () => {
    expect(windowsAclArgv("C:\\state\\connection.json", "host\\user")).toEqual([
      "C:\\state\\connection.json", "/inheritance:r", "/grant:r", "host\\user:(F)",
    ]);
  });
});
