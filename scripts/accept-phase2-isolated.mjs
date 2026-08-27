import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

import { readTarGz, stableJson } from "./phase2-pack-lib.mjs";

const outFlag = process.argv.indexOf("--out");
const out = resolve(outFlag >= 0 ? process.argv[outFlag + 1] : ".artifacts/phase2");
const root = await mkdtemp(join(tmpdir(), "dsh-session-maintenance-phase2-"));
const profile = join(root, "marked-official-rc2-profile-fixture");
const engineState = join(root, "engine-state-preserved-on-uninstall");
const pluginRoot = join(profile, "node_modules", "dsh-session-maintenance");
const routes = new Map();
const effects = [];
let engineServer;
let profileServer;

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
  if (address === null || typeof address === "string") throw new Error("isolated fixture server has no address");
  return `http://127.0.0.1:${address.port}`;
}

try {
  await mkdir(pluginRoot, { recursive: true });
  await mkdir(engineState, { recursive: true });
  await writeFile(join(profile, ".dsh-session-maintenance-fixture.json"), stableJson({ officialContract: "0.1.1-rc.2", synthetic: true }));
  const archive = readTarGz(await readFile(join(out, "dsh-session-maintenance-0.1.0.tgz")));
  for (const [name, bytes] of archive) {
    if (!name.startsWith("package/") || name.includes("..")) throw new Error(`Unsafe plugin archive entry: ${name}`);
    const target = join(pluginRoot, name.slice("package/".length));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }

  const engineToken = randomBytes(32).toString("base64url");
  engineServer = createServer((request, response) => {
    const authorized = request.headers.authorization === `Bearer ${engineToken}`;
    const body = authorized
      ? { status: { ready: true, instanceCount: 1 } }
      : { error: { code: "UNAUTHORIZED" } };
    response.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  const engineOrigin = await listen(engineServer);
  const enginePort = Number(new URL(engineOrigin).port);
  const descriptor = join(engineState, "connection.json");
  await writeFile(descriptor, stableJson({ schemaVersion: 1, host: "127.0.0.1", port: enginePort, token: engineToken }));
  process.env.DSH_SESSION_MAINTENANCE_CONNECTION_PRIMARY = descriptor;

  const plugin = await import(`${pathToFileURL(join(pluginRoot, "lib", "index.js")).href}?isolated=${Date.now()}`);
  let clientRegistration;
  runInNewContext(await readFile(join(pluginRoot, "lib", "client", "index.js"), "utf8"), {
    window: { __ModuleLoader__: { load: (registration) => { clientRegistration = registration; } } },
  });
  if (clientRegistration?.id !== "dsh-session-maintenance" || typeof clientRegistration.factory !== "function") {
    throw new Error("Packaged client did not register a DSH client-module factory");
  }
  const method = async () => undefined;
  const runtime = {
    sessions: { get: () => undefined },
    sessionPersistence: {
      list: method, inspect: method, locate: method, create: method, append: method,
      coordinator: { states: new Map(), serialize: method, preparations: { invalidate: () => undefined } },
    },
    workspaceRegistry: {
      list: () => [], get: () => undefined, archiveSession: method, setState: method,
      enqueueOperation: method, replaceHeaderIndex: method,
    },
    sessionProjectionCache: { table: { get: () => undefined, put: method, delete: method } },
    sessionQuery: { _ensureReady: method, _reconcile: method, _serialized: method },
    webServer: {
      register: ({ path, handler }) => {
        routes.set(path, handler);
        return () => routes.delete(path);
      },
    },
    effect: (callback) => { effects.push(callback()); },
  };
  plugin.apply(runtime, { connectionId: "primary", dshInstanceId: "dsh-fixture", profileId: "isolated-web" });
  if (routes.size !== 2) throw new Error("Packaged plugin did not register both host endpoints");
  profileServer = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const handler = routes.get(path);
    if (handler === undefined) { response.writeHead(404); response.end(); return; }
    void handler(request, response);
  });
  const profileOrigin = await listen(profileServer);
  const proxy = await fetch(`${profileOrigin}/dsh-session-maintenance/api`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ operation: "status" }),
  });
  if (!proxy.ok || !((await proxy.json()).ok)) throw new Error("Packaged host proxy did not reach the fixture Engine");
  const scope = { transactionId: "probe", planHash: "probe", instanceId: "dsh-fixture", sessionId: "probe" };
  const core = await fetch(`${profileOrigin}/dsh-session-maintenance/core`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "probe", token: gatewayToken(engineToken, scope), scope }),
  });
  const coreBody = await core.json();
  if (!core.ok || coreBody.result?.status !== "compatible") throw new Error("Packaged rc.2 Core gateway probe failed");
  for (const dispose of effects.reverse()) if (typeof dispose === "function") dispose();
  if (routes.size !== 0) throw new Error("Plugin unload left host routes registered");
  await rm(profile, { recursive: true, force: true });
  await readFile(descriptor);
  const report = {
    schemaVersion: 1,
    syntheticOfficialContract: "0.1.1-rc.2",
    packageImport: "passed",
    clientModuleRegistration: "passed",
    hostProxy: "passed",
    materializedCoreProbe: "passed",
    unloadCleanup: "passed",
    engineStatePreservedAfterProfileRemoval: "passed",
  };
  await writeFile(join(out, "isolated-acceptance.json"), `${stableJson(report)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  delete process.env.DSH_SESSION_MAINTENANCE_CONNECTION_PRIMARY;
  await Promise.all([engineServer, profileServer].filter(Boolean).map((server) => new Promise((resolveClose) => server.close(() => resolveClose()))));
  await rm(root, { recursive: true, force: true });
}
