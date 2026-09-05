import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEngineDashboardRoot } from "../src/dashboard-root.js";
import { createEngineFixture } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function fixture(name: string) {
  const value = await createEngineFixture(`dashboard-discovery-${name}`);
  cleanups.push(value.cleanupAll);
  return value;
}
async function dashboard(root: string) {
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), '<!doctype html><script src="/dashboard/assets/app.js"></script>');
  await writeFile(join(root, "assets/app.js"), "globalThis.maintenanceDashboard=true;");
}

describe("Dashboard discovery for normal Engine startup", () => {
  it("serves the workspace build without requiring a launcher argument", async () => {
    const value = await fixture("workspace");
    const root = join(value.root, "apps/dashboard/dist");
    await dashboard(root);
    const discovered = await resolveEngineDashboardRoot(undefined, pathToFileURL(join(value.root, "apps/engine/dist/dashboard-root.js")).href);
    expect(discovered).toBe(root);
    const server = await value.startServer({ dashboardRoot: discovered! });
    expect((await fetch(`${server.origin}/dashboard/`)).status).toBe(200);
    expect(await (await fetch(`${server.origin}/dashboard/assets/app.js`)).text()).toContain("maintenanceDashboard");
    expect((await fetch(`${server.origin}/v1/canonical/sessions`)).status).toBe(401);
  });

  it("finds the portable archive layout beside the Engine executable", async () => {
    const value = await fixture("portable");
    const root = join(value.root, "dashboard");
    await dashboard(root);
    expect(await resolveEngineDashboardRoot(undefined, pathToFileURL(join(value.root, "engine/dsh-session-maint.mjs")).href)).toBe(root);
  });

  it("honors an explicit trusted root and rejects a missing explicit build", async () => {
    const value = await fixture("override");
    const root = join(value.root, "chosen-ui");
    await dashboard(root);
    expect(await resolveEngineDashboardRoot(root)).toBe(root);
    await expect(resolveEngineDashboardRoot(join(value.root, "absent"))).rejects.toThrow("index.html is missing");
  });

  it("keeps a headless installation usable and does not search the working directory", async () => {
    const value = await fixture("headless");
    expect(await resolveEngineDashboardRoot(undefined, pathToFileURL(join(value.root, "empty/engine/main.mjs")).href)).toBeUndefined();
  });
});
