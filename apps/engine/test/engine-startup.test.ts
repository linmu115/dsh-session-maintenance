import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { MaintenanceWriteCoordinator } from "@linmu/dsh-session-store";
import { recoverDeadEngineOwner, startManagedEngine } from "../src/engine-startup.js";
import { lifecycleErrorCode, recordEngineLifecycle, readEngineStartupFailure } from "../src/engine-lifecycle-log.js";

const cleanups: Array<() => Promise<void>> = [];
let buildRoot: string;
let entry: string;
beforeAll(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), "SYNTHETIC-engine-startup-build-"));
  await symlink(resolve("apps/engine/node_modules"), join(buildRoot, "node_modules"), "junction");
  entry = join(buildRoot, "engine.mjs");
  await build({
    stdin: { contents: `import { runCli } from './apps/engine/src/cli.ts';
      import { resolve, relative, isAbsolute, join } from 'node:path';
      import { existsSync } from 'node:fs';
      const root = resolve(process.argv[process.argv.indexOf('--state-root') + 1]);
      if (!existsSync(join(root, 'SYNTHETIC'))) throw new Error('Unmarked fixture');
      process.env.CODEX_HOME = join(root, 'codex');
      process.on('message', value => { if (value === 'stop') process.emit('SIGTERM'); });
      process.exitCode = await runCli(process.argv.slice(2), { fixturePolicy: path => {
        const rel = relative(root, resolve(path));
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Outside synthetic root');
      } });
      if (process.connected) process.disconnect();`, resolveDir: resolve(".") },
    outfile: entry, bundle: true, platform: "node", format: "esm", target: "node22",
    conditions: ["development"], banner: { js: 'import {createRequire as startupTestRequire} from "node:module"; const require=startupTestRequire(import.meta.url);' },
  });
});
afterAll(async () => {
  // Unlink the dependency junction before recursively removing our temp root.
  await rm(join(buildRoot, "node_modules"));
  await rm(buildRoot, { recursive: true, force: true });
});
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "SYNTHETIC-engine-startup-"));
  await writeFile(join(root, "SYNTHETIC"), "Startup regression fixture; no user homes.");
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}
async function waitFor<T>(get: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await get();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Synthetic child did not reach expected state");
}
function launch(root: string, args: string[] = []) {
  const child = spawn(process.execPath, [entry, "--state-root", root, "serve", "--recover-dead-owner", ...args], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, CODEX_HOME: join(root, "codex") },
  });
  const exited = once(child, "exit");
  let stdout = ""; let stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } });
  return { child, exited, stderr: () => stderr, ready: () => waitFor(async () => {
    if (child.exitCode !== null) throw new Error(stderr);
    return stdout.includes('"origin"') ? true : undefined;
  }) };
}
async function stop(child: ChildProcess, exited: Promise<unknown>) { child.send("stop"); await exited; }

it("releases ownership and records drain stages on graceful shutdown", async () => {
  const root = await fixture(); const run = launch(root); await run.ready();
  await stop(run.child, run.exited);
  expect(run.child.exitCode, run.stderr()).toBe(0);
  expect(existsSync(join(root, "maintenance-writer.json"))).toBe(false);
  expect(existsSync(join(root, "connection.json"))).toBe(false);
  const events = (await readFile(join(root, "logs", "engine-lifecycle", `${run.child.pid}.jsonl`), "utf8")).trim().split("\n").map(line => JSON.parse(line).stage);
  expect(events).toEqual(["startup.begin", "startup.ready", "shutdown.requested", "shutdown.drain-started", "shutdown.drained", "owner.released", "shutdown.completed"]);
});

it("recovers after a real forced child exit and archives matching crash ownership", async () => {
  const root = await fixture(); const first = launch(root); await first.ready();
  const owner = MaintenanceWriteCoordinator.inspect(root);
  first.child.kill("SIGKILL"); await first.exited;
  expect(existsSync(join(root, "maintenance-writer.json"))).toBe(true);
  const next = launch(root); await next.ready();
  expect(MaintenanceWriteCoordinator.inspect(root).pid).toBe(next.child.pid);
  expect(JSON.parse(await readFile(join(root, `maintenance-writer.dead-${owner.ownerId}.json`), "utf8"))).toEqual(owner);
  expect(JSON.parse(await readFile(join(root, `connection.dead-${owner.ownerId}.json`), "utf8"))).toMatchObject({ pid: first.child.pid, ownerId: owner.ownerId });
  await stop(next.child, next.exited);
});

it("releases an acquired owner after a port-bind failure and records the actual safe error code", async () => {
  const root = await fixture(); const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => listener.close(() => resolve())));
  const address = listener.address(); if (address === null || typeof address === "string") throw new Error("missing port");
  const run = launch(root, ["--port", String(address.port)]); await run.exited;
  expect(run.child.exitCode).toBe(1);
  expect(existsSync(join(root, "maintenance-writer.json"))).toBe(false);
  expect(existsSync(join(root, "connection.json"))).toBe(false);
  expect(readEngineStartupFailure(root, run.child.pid!, 0)).toBe("EADDRINUSE");
});

it("concurrent Launcher starts have one owner and the losing monitor joins the winner", async () => {
  const root = await fixture();
  const monitors = await Promise.all([startManagedEngine(root, entry), startManagedEngine(root, entry)]);
  cleanups.push(async () => { for (const monitor of monitors) monitor.dispose(); });
  const descriptor = await waitFor(async () => {
    try { return JSON.parse(await readFile(join(root, "connection.json"), "utf8")) as { pid: number; port: number }; } catch { return undefined; }
  });
  cleanups.push(async () => {
    // PID comes from this freshly generated synthetic root, never user state.
    process.kill(descriptor.pid, "SIGKILL");
    await waitFor(async () => { try { process.kill(descriptor.pid, 0); return undefined; } catch { return true; } });
  });
  expect(MaintenanceWriteCoordinator.inspect(root).pid).toBe(descriptor.pid);
  expect((await fetch(`http://127.0.0.1:${descriptor.port}/v1/health`)).ok).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 1_200));
  expect(await Promise.all(monitors.map(monitor => monitor.failure()))).toEqual([undefined, undefined]);
});

it("does not recover live, foreign, offline, mismatched or uncertain ownership", async () => {
  const root = await fixture(); const writes = MaintenanceWriteCoordinator.acquire(root);
  const original = MaintenanceWriteCoordinator.inspect(root);
  expect(() => recoverDeadEngineOwner(root)).toThrow("WRITER_OWNER_ACTIVE");
  for (const patch of [{ hostname: "foreign-host" }, { mode: "offline" }]) {
    await writeFile(join(root, "maintenance-writer.json"), JSON.stringify({ ...original, ...patch }));
    expect(() => recoverDeadEngineOwner(root)).toThrow("WRITER_OWNER_UNKNOWN");
  }
  await writeFile(join(root, "maintenance-writer.json"), JSON.stringify(original));
  await writeFile(join(root, "maintenance-writer-recovery.json"), "unresolved recovery");
  expect(() => recoverDeadEngineOwner(root)).toThrow("WRITER_RECOVERY_REQUIRED");
  await rm(join(root, "maintenance-writer-recovery.json"));
  writes.close();
  const child = spawn(process.execPath, ["-e", ""], { windowsHide: true }); await once(child, "exit");
  const dead = { ...original, pid: child.pid, hostname: hostname(), ownerId: randomUUID() };
  await writeFile(join(root, "maintenance-writer.json"), JSON.stringify(dead));
  await writeFile(join(root, "connection.json"), JSON.stringify({ pid: child.pid, ownerId: randomUUID() }));
  expect(() => recoverDeadEngineOwner(root)).toThrow("WRITER_OWNER_UNKNOWN");
  expect(JSON.parse(await readFile(join(root, "maintenance-writer.json"), "utf8"))).toEqual(dead);
});

it("detects actual early child failure and records only safe error codes", async () => {
  const root = await fixture();
  await writeFile(join(root, "maintenance-writer-recovery.json"), "unresolved recovery");
  const monitor = await startManagedEngine(root, entry); cleanups.push(async () => monitor.dispose());
  const started = Date.now();
  expect(await waitFor(() => monitor.failure())).toBe("WRITER_RECOVERY_REQUIRED");
  expect(Date.now() - started).toBeLessThan(5_000);
  const secret = "Bearer secret-session-text";
  recordEngineLifecycle(root, "startup.failed", lifecycleErrorCode(new Error(`WRITER_OWNER_UNKNOWN: ${secret}`)));
  const log = await readFile(join(root, "logs", "engine-lifecycle", `${process.pid}.jsonl`), "utf8");
  expect(log).not.toContain(secret);
  expect(readEngineStartupFailure(root, process.pid, started)).toBe("WRITER_OWNER_UNKNOWN");
  expect(readEngineStartupFailure(root, process.pid, Date.now() + 1_000)).toBeUndefined();
});
