import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { assertFixtureSandbox } from "../../../packages/test-support/src/index.js";
import { createEngineFixture } from "./helpers.js";
import { loadConfig, registeredInstances } from "../src/config.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolveGate) => { release = resolveGate; });
  return { promise, release };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing synthetic test port");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

it("does not listen, report healthy or publish discovery while startup recovery is pending", async () => {
  const fixture = await createEngineFixture("startup-readiness-SYNTHETIC");
  cleanups.push(fixture.cleanupAll);
  const entered = gate(), ready = gate(), port = await freePort();
  const original = fixture.engine.jobs.start.bind(fixture.engine.jobs);
  vi.spyOn(fixture.engine.jobs, "start").mockImplementation(() => {
    entered.release();
    return ready.promise.then(original);
  });
  const starting = fixture.startServer({ port });
  await entered.promise;
  try {
    const status = await fetch(`http://127.0.0.1:${port}/v1/health`).then((response) => response.status, () => null);
    expect(status).toBeNull();
    await expect(access(join(fixture.stateRoot, "connection.json"))).rejects.toThrow();
    expect(fixture.engine.repository.database.prepare("SELECT count(*) AS count FROM jobs").get()).toMatchObject({ count: 0 });
  } finally {
    ready.release();
    await starting;
  }
  expect((await fetch(`http://127.0.0.1:${port}/v1/health`)).status).toBe(200);
});

it("leaves no listener or discovery file when startup recovery fails", async () => {
  const fixture = await createEngineFixture("startup-failure-SYNTHETIC");
  cleanups.push(fixture.cleanupAll);
  const port = await freePort();
  vi.spyOn(fixture.engine.jobs, "start").mockImplementation(() => { throw new Error("synthetic recovery failure"); });
  await expect(fixture.startServer({ port })).rejects.toThrow("synthetic recovery failure");
  expect(await fetch(`http://127.0.0.1:${port}/v1/health`).then((response) => response.status, () => null)).toBeNull();
  expect((await readdir(fixture.stateRoot)).filter((name) => name.startsWith("connection.json"))).toEqual([]);
});

it("closes the listener and removes its temporary file when discovery publication fails", async () => {
  const fixture = await createEngineFixture("startup-publication-SYNTHETIC");
  cleanups.push(fixture.cleanupAll);
  const port = await freePort();
  await mkdir(join(fixture.stateRoot, "connection.json"));
  await expect(fixture.startServer({ port })).rejects.toThrow();
  expect(await fetch(`http://127.0.0.1:${port}/v1/health`).then((response) => response.status, () => null)).toBeNull();
  expect((await readdir(fixture.stateRoot)).filter((name) => name.startsWith("connection.json"))).toEqual(["connection.json"]);
});

async function externalLifecycle(stateRoot: string, request: unknown) {
  assertFixtureSandbox(stateRoot);
  for (const instance of registeredInstances(await loadConfig(stateRoot))) assertFixtureSandbox(instance.root);
  // Real CLI entry points cannot receive an in-process fixtureGuard. Validate
  // every root above, then launch them in the ordinary CLI environment rather
  // than inheriting Vitest's constructor-only fixture-guard requirement.
  const environment = { ...process.env };
  delete environment.VITEST;
  const child = spawn(process.execPath, [resolve("apps/engine/dist/main.js"), "--state-root", stateRoot, "external-lifecycle"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: environment,
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
  child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
  const timer = setTimeout(() => child.kill(), 25_000);
  try {
    const completed = new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolveExit(code));
    });
    child.stdin.end(JSON.stringify(request));
    return { code: await completed, stdout, stderr };
  } finally { clearTimeout(timer); }
}

it("refuses to auto-start Maintenance from the lifecycle CLI and leaves the instance stopped", async () => {
  const fixture = await createEngineFixture("explicit-engine-start-SYNTHETIC");
  await fixture.stop();
  cleanups.push(fixture.cleanup);
  const result = await externalLifecycle(fixture.stateRoot, {
    schemaVersion: 1, phase: "prepare", instanceId: "cold-synthetic", profileId: "web", runtimeVersion: "0.1.2-rc.1", web: true,
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("请先启动并确认维护服务就绪");
  await expect(access(join(fixture.stateRoot, "connection.json"))).rejects.toThrow();
  await expect(access(join(fixture.stateRoot, "maintenance-writer.json"))).rejects.toThrow();
});
