import { createHmac, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { stableJson } from "./phase2-pack-lib.mjs";

const EXPECTED_DSH = "0.1.1-rc.2";
const outFlag = process.argv.indexOf("--out");
const installFlag = process.argv.indexOf("--install-root");
const out = resolve(outFlag >= 0 ? process.argv[outFlag + 1] : ".artifacts/phase2");
const installRootInput = installFlag >= 0 ? process.argv[installFlag + 1] : process.env.DSH_INSTALL_ROOT;
if (installRootInput === undefined || !isAbsolute(installRootInput)) {
  throw new Error("Set DSH_INSTALL_ROOT or pass --install-root with the official DSH installation root");
}
const installRoot = await realpath(installRootInput);
const runtimeRoot = join(installRoot, `runtime-${EXPECTED_DSH}`);
const dshManifestPath = join(runtimeRoot, "node_modules", "@deepseek-ai", "dsh", "package.json");
const dshBin = join(runtimeRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const dshManifest = JSON.parse(await readFile(dshManifestPath, "utf8"));
if (dshManifest.version !== EXPECTED_DSH) {
  throw new Error(`Official runtime drift: expected ${EXPECTED_DSH}, got ${String(dshManifest.version)}`);
}

const root = await mkdtemp(join(tmpdir(), "dsh-session-maintenance-official-rc2-"));
const marker = join(root, ".phase2-official-profile-marker.json");
const dshHome = join(root, "home");
const engineState = join(root, "engine-state");
const pluginArtifact = resolve(out, "dsh-session-maintenance-0.1.0.tgz");
const logParts = [];
let engineServer;
let dshProcess;
let engineToken = "";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function gatewayToken(secret, scope) {
  const payload = { schemaVersion: 1, ...scope, expiresAt: Date.now() + 60_000, nonce: randomBytes(16).toString("hex") };
  const body = Buffer.from(canonical(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", Buffer.from(secret)).update(body).digest("base64url")}`;
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolveListen(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("loopback server has no port");
  return address.port;
}

async function reservePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolveClose, reject) => server.close((error) => error === undefined ? resolveClose() : reject(error)));
  return port;
}

function scrub(value, token) {
  const withoutRoot = value.replaceAll(root, "[TEMP_PROFILE]");
  return (token === "" ? withoutRoot : withoutRoot.replaceAll(token, "[REDACTED]"))
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]");
}

async function waitForHttp(origin, process, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (process.exitCode !== null || process.signalCode !== null) {
      throw new Error(`Official DSH exited before readiness with code ${String(process.exitCode ?? process.signalCode)}`);
    }
    try {
      const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return response.text();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Official DSH did not become ready: ${String(lastError)}`);
}

async function waitForHostProxy(origin, process, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = { status: 0, text: "not attempted" };
  while (Date.now() < deadline) {
    if (process.exitCode !== null || process.signalCode !== null) {
      throw new Error(`Official DSH exited before host proxy readiness with code ${String(process.exitCode ?? process.signalCode)}`);
    }
    try {
      const response = await fetch(`${origin}/dsh-session-maintenance/api`, {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ operation: "status" }),
        signal: AbortSignal.timeout(1_500),
      });
      const text = await response.text();
      last = { status: response.status, text };
      let body;
      try { body = JSON.parse(text); } catch { body = undefined; }
      if (response.ok && body?.ok === true) return;
    } catch (error) {
      last = { status: 0, text: String(error) };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Official host proxy did not become ready (HTTP ${last.status}: ${last.text.slice(0, 300)})`);
}

async function stopProcess(process) {
  if (process === undefined || process.exitCode !== null || process.signalCode !== null) return;
  const exited = new Promise((resolveExit) => process.once("exit", resolveExit));
  process.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 8_000))]);
  if (process.exitCode === null && process.signalCode === null) {
    process.kill("SIGKILL");
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 3_000))]);
  }
  if (process.exitCode === null && process.signalCode === null) throw new Error(`Could not stop isolated official DSH process ${process.pid}`);
}

try {
  await stat(pluginArtifact);
  await mkdir(engineState, { recursive: true });
  await writeFile(marker, `${stableJson({ schemaVersion: 1, purpose: "phase2-official-profile-acceptance" })}\n`);

  engineToken = randomBytes(32).toString("base64url");
  engineServer = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${engineToken}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "UNAUTHORIZED" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: { ready: true, instanceCount: 1 } }));
  });
  const enginePort = await listen(engineServer);
  const descriptor = join(engineState, "connection.json");
  await writeFile(descriptor, `${stableJson({ schemaVersion: 1, host: "127.0.0.1", port: enginePort, token: engineToken })}\n`);

  const isolatedEnv = {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_INSTALL_ROOT: installRoot,
    DSH_TELEMETRY_DISABLED: "1",
    DSH_SESSION_MAINTENANCE_CONNECTION_PRIMARY: descriptor,
  };
  const install = spawnSync(process.execPath, [
    dshBin,
    "plugin", "--profile", "web", "add", pluginArtifact, "--offline", "--ignore-scripts",
  ], {
    cwd: root,
    env: isolatedEnv,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 60_000,
  });
  logParts.push(install.stdout ?? "", install.stderr ?? "");
  if (install.error !== undefined) throw install.error;
  if (install.status !== 0) throw new Error(`Official DSH plugin install failed with code ${install.status}`);
  const profileManifest = JSON.parse(await readFile(join(dshHome, "profiles", "web", "package.json"), "utf8"));
  if (profileManifest.dependencies?.["dsh-session-maintenance"] === undefined) throw new Error("Official installer did not record the packaged plugin");
  if (!profileManifest.dsh?.profile?.bundles?.includes("dsh-session-maintenance")) throw new Error("Official installer did not activate the plugin bundle");

  const dshPort = await reservePort();
  dshProcess = spawn(process.execPath, [
    dshBin,
    "--profile", "web", "--host", "127.0.0.1", "--port", String(dshPort), "--no-open",
  ], { cwd: root, env: isolatedEnv, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
  dshProcess.stdout.setEncoding("utf8");
  dshProcess.stderr.setEncoding("utf8");
  dshProcess.stdout.on("data", (chunk) => logParts.push(chunk));
  dshProcess.stderr.on("data", (chunk) => logParts.push(chunk));
  const origin = `http://127.0.0.1:${dshPort}`;
  const html = await waitForHttp(origin, dshProcess);
  if (!html.includes("dsh-session-maintenance")) throw new Error("Official client module graph omitted dsh-session-maintenance");
  const clientBundle = await fetch(`${origin}/plugins/dsh-session-maintenance/client.js`);
  const clientBody = await clientBundle.text();
  if (!clientBundle.ok || !clientBody.includes('__ModuleLoader__.load({ id: "dsh-session-maintenance"')) {
    throw new Error("Official client-module route did not serve the packaged factory");
  }
  await waitForHostProxy(origin, dshProcess);
  const scope = { transactionId: "official-probe", planHash: "official-probe", instanceId: "dsh-web", sessionId: "official-probe" };
  const core = await fetch(`${origin}/dsh-session-maintenance/core`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "probe", token: gatewayToken(engineToken, scope), scope }),
  });
  const coreBody = await core.json();
  if (!core.ok || coreBody.result?.status !== "compatible") throw new Error("Official runtime Core materialization probe failed");

  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  const scrubbedLog = scrub(logParts.join(""), engineToken);
  const loaderFailure = /failed to load plugins|failed to import loader entry|client-modules:[^\r\n]*(?:failed|missing|drift)|dsh-session-maintenance[^\r\n]*(?:failed|error)/iu.exec(scrubbedLog);
  if (loaderFailure !== null) throw new Error(`Official loader diagnostic failed: ${loaderFailure[0]}`);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "official-profile-loader.log"), scrubbedLog.slice(-64 * 1024));
  const report = {
    schemaVersion: 1,
    officialDshVersion: EXPECTED_DSH,
    isolatedHome: true,
    officialInstaller: "passed",
    minimalWebStack: "passed",
    clientModuleGraph: "passed",
    clientBundleRoute: "passed",
    hostProxy: "passed",
    materializedCoreProbe: "passed",
    loaderDiagnostics: "passed",
    formalHomeTouched: false,
  };
  await writeFile(join(out, "official-profile-acceptance.json"), `${stableJson(report)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  const diagnostics = scrub(logParts.join(""), engineToken).slice(-16 * 1024);
  if (diagnostics !== "") process.stderr.write(`\n--- isolated official DSH diagnostics ---\n${diagnostics}\n`);
  throw error;
} finally {
  let cleanupError;
  try { await stopProcess(dshProcess); } catch (error) { cleanupError = error; }
  try {
    if (engineServer !== undefined) await new Promise((resolveClose) => engineServer.close(() => resolveClose()));
  } catch (error) { cleanupError ??= error; }
  try {
    const markerContents = await readFile(marker, "utf8").catch(() => "");
    const tempRelative = relative(await realpath(tmpdir()), root);
    if (!markerContents.includes("phase2-official-profile-acceptance") || tempRelative === "" || tempRelative.startsWith("..")) {
      throw new Error("Refusing to remove an unmarked or non-temporary acceptance directory");
    }
    await rm(root, { recursive: true, force: true });
  } catch (error) { cleanupError ??= error; }
  if (cleanupError !== undefined) throw cleanupError;
}
