import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEngineFixture } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("packaged Dashboard static boundary", () => {
  it("serves only the fixed Dashboard index and hashed asset namespace", async () => {
    const fixture = await createEngineFixture("dashboard-static");
    cleanups.push(fixture.cleanupAll);
    const dashboard = join(fixture.root, "dashboard");
    await mkdir(join(dashboard, "assets"), { recursive: true });
    await writeFile(join(dashboard, "index.html"), "<!doctype html><script src=\"/dashboard/assets/app-fixture.js\"></script>");
    await writeFile(join(dashboard, "assets", "app-fixture.js"), "globalThis.dashboardFixture=true;");
    await writeFile(join(fixture.root, "secret.txt"), "not served");
    const server = await fixture.startServer({ dashboardRoot: dashboard });
    const page = await fetch(`${server.origin}/dashboard/`);
    expect({ status: page.status, csp: page.headers.get("content-security-policy"), body: await page.text() }).toEqual({
      status: 200,
      csp: expect.stringContaining("connect-src 'self'"),
      body: expect.stringContaining("/dashboard/assets/app-fixture.js"),
    });
    expect((await fetch(`${server.origin}/dashboard/assets/app-fixture.js`)).status).toBe(200);
    expect((await fetch(`${server.origin}/dashboard/%2e%2e/secret.txt`)).status).toBe(401);
  });
});
