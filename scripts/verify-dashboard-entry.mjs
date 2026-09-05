import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertFixtureSandbox, createFixtureSandbox } from "../packages/test-support/dist/index.js";
import { readTarGz, sha256 } from "./phase2-pack-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const archivePath = process.argv[2];
if (archivePath === undefined) throw new TypeError("Usage: node scripts/verify-dashboard-entry.mjs <engine-dashboard.tgz>");
const archive = await readFile(resolve(archivePath));
const fixture = await createFixtureSandbox("packaged-dashboard-entry");
const installation = join(fixture.root, "installation");
const state = join(fixture.root, "state");
const cwd = join(fixture.root, "unrelated-cwd");
let running;

function child(argv) {
  let output = "";
  const processHandle = spawn(process.execPath, argv, {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  processHandle.stdout.on("data", (data) => { output = (output + data).slice(-32_768); });
  processHandle.stderr.on("data", (data) => { output = (output + data).slice(-32_768); });
  const completed = new Promise((accept, reject) => {
    processHandle.once("error", reject);
    processHandle.once("close", (code) => accept(code));
  });
  return { processHandle, completed, output: () => output };
}

async function finish(value) {
  if (value.processHandle.exitCode !== null) return value.completed;
  if (value.processHandle.connected) value.processHandle.send("verify-stop");
  else value.processHandle.kill("SIGTERM");
  const fallback = setTimeout(() => value.processHandle.kill("SIGTERM"), 5000);
  try { return await value.completed; } finally { clearTimeout(fallback); }
}

try {
  await mkdir(installation);
  await mkdir(cwd);
  for (const [name, bytes] of readTarGz(archive)) {
    assert.ok(name.startsWith("dsh-session-maintenance/"), `Unexpected archive entry: ${name}`);
    assert.ok(!name.includes("\\") && !name.split("/").includes(".."), `Invalid archive path: ${name}`);
    const target = resolve(installation, name);
    const suffix = relative(installation, target);
    assert.ok(suffix && !suffix.startsWith("..") && !isAbsolute(suffix));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
  }
  const entry = join(installation, "dsh-session-maintenance/engine/dsh-session-maint.mjs");
  const wrapper = join(fixture.root, "cli-entry.mjs");
  // IPC asks the CLI to take its own signal shutdown path on Windows as well.
  await writeFile(wrapper, [
    'process.on("message", value => { if (value === "verify-stop") process.emit("SIGTERM"); });',
    `await import(${JSON.stringify(pathToFileURL(entry).href)});`,
    "if (process.connected) process.disconnect();",
  ].join("\n"));
  running = child([wrapper, "--state-root", state, "init"]);
  assert.equal(await running.completed, 0, running.output());
  running = child([wrapper, "--state-root", state, "serve", "--port", "0"]);
  let connection;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { connection = JSON.parse(await readFile(join(state, "connection.json"), "utf8")); break; }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    assert.equal(running.processHandle.exitCode, null, running.output());
    await delay(100);
  }
  assert.ok(connection, running.output());
  const origin = `http://${connection.host}:${connection.port}`;
  const request = (path, options = {}) => fetch(`${origin}${path}`, { ...options, signal: AbortSignal.timeout(5000) });
  const page = await request("/dashboard/");
  assert.equal(page.status, 200);
  const html = await page.text();
  const script = html.match(/src="(\/dashboard\/assets\/[^"]+\.js)"/u)?.[1];
  assert.ok(script, "Dashboard must include its built application");
  assert.equal((await request(script)).status, 200);
  const trusted = { authorization: `Bearer ${connection.token}`, "content-type": "application/json" };
  assert.equal((await request("/v1/health", { headers: trusted })).status, 200);
  assert.equal((await request("/v1/canonical/sessions")).status, 401);
  const launchResponse = await request("/v1/ui/launch-code", { method: "POST", headers: trusted, body: "{}" });
  assert.equal(launchResponse.status, 201);
  const launch = await launchResponse.json();
  const launchUrl = launch.launch?.url;
  assert.equal(new URL(launchUrl).origin, origin);
  const claim = await fetch(launchUrl, { redirect: "manual", signal: AbortSignal.timeout(5000) });
  assert.equal(claim.status, 303);
  assert.equal(claim.headers.get("location"), "/dashboard/");
  const cookie = claim.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const bootstrap = await request("/v1/ui/session", { headers: { cookie, "sec-fetch-site": "same-origin" } });
  assert.equal(bootstrap.status, 200);
  const session = await bootstrap.json();
  assert.equal((await request("/v1/overview", { headers: { cookie, origin, "x-dsh-csrf": session.session.csrfToken } })).status, 200);
  assert.equal((await fetch(launchUrl, { redirect: "manual", signal: AbortSignal.timeout(5000) })).status, 410);
  assert.equal(await finish(running), 0, running.output());
  running = undefined;
  process.stdout.write(`${JSON.stringify({ verified: true, packageSha256: sha256(archive), packageRoot: relative(root, resolve(archivePath)), defaultDashboardDiscovery: true, unrelatedWorkingDirectory: true, uiClaimAndBootstrap: true, apiAuthentication: true, gracefulCliShutdown: true, state: "marked-synthetic-fixture-only" })}\n`);
} finally {
  if (running !== undefined) await finish(running);
  assertFixtureSandbox(fixture.root);
  await fixture.cleanup();
}
