import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtureSandbox, assertFixtureSandbox } from "../../../packages/test-support/src/index.js";
import { createReadOnlyComposition } from "../src/composition-root.js";
import { startMaintenanceServer } from "../src/http/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const cliPackage = "@deepseek-ai/dsh";
const json = async (path: string, value: unknown) => { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify(value)); };

/** A DSH Home laid out the way the official install leaves it, with no Launcher anywhere. */
async function syntheticHome() {
  const sandbox = await createFixtureSandbox("instance-folder-route");
  cleanups.push(sandbox.cleanup);
  const root = await realpath(sandbox.root);
  const homeRoot = join(root, "my-dsh-home"), versionRoot = join(root, "runtime");
  const profileRoot = join(homeRoot, "profiles", "web");
  await mkdir(join(homeRoot, "sessions", "--D-fixture--"), { recursive: true });
  await mkdir(profileRoot, { recursive: true });
  await json(join(versionRoot, "package.json"), { name: "local-runtime", private: true });
  await json(join(versionRoot, "node_modules", cliPackage, "package.json"), { name: cliPackage, version: "0.1.2-rc.1", private: true });
  await mkdir(join(versionRoot, "node_modules", cliPackage, "lib"), { recursive: true });
  await writeFile(join(versionRoot, "node_modules", cliPackage, "lib", "bin.js"), "// synthetic CLI");
  // A profile enables the Web app and the base bundle; the Maintenance
  // integration bundle is what makes the profile takeable.
  for (const name of ["dsh-base", "dsh-web-app"]) {
    const directory = join(profileRoot, "node_modules", "@deepseek-ai", name);
    await json(join(directory, "package.json"), { name: `@deepseek-ai/${name}`, version: "0.1.2-rc.1", main: "index.js",
      dsh: { bundle: { patch: "./cordis.patch.yml" } } });
    await writeFile(join(directory, "index.js"), "// synthetic");
    await writeFile(join(directory, "cordis.patch.yml"), "- insert:\n    - id: webserver\n      name: '@deepseek-ai/dsh-webserver'\n");
  }
  // A connected instance has the Maintenance integration bundle installed; a
  // takeover is only ever offered for a profile where the plugin can answer, so
  // the fixture mirrors the installed plugin's own version and declaration.
  const pluginManifest = JSON.parse(await readFile(new URL("../../../plugins/dsh-session-maintenance/package.json", import.meta.url), "utf8"));
  await json(join(profileRoot, "node_modules", "dsh-session-maintenance", "package.json"),
    { name: "dsh-session-maintenance", version: pluginManifest.version, main: "index.js",
      dsh: { bundle: { patch: "./cordis.patch.yml" } }, dshMaintenanceIntegration: pluginManifest.dshMaintenanceIntegration });
  await writeFile(join(profileRoot, "node_modules", "dsh-session-maintenance", "index.js"), "// synthetic plugin");
  await writeFile(join(profileRoot, "node_modules", "dsh-session-maintenance", "cordis.patch.yml"),
    "- insert:\n    - id: session-maintenance\n      name: dsh-session-maintenance\n");
  await json(join(profileRoot, "package.json"), { name: "dsh-profile-web", private: true,
    devDependencies: { [cliPackage]: `link:${join(versionRoot, "node_modules", cliPackage)}` },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-session-maintenance"] } } });
  return { root, homeRoot, versionRoot, profileRoot };
}

async function fixture() {
  const home = await syntheticHome();
  const stateRoot = join(home.root, "state");
  await mkdir(stateRoot);
  // An empty Launcher catalog keeps discovery from reading the developer's real
  // Launcher, so this fixture sees only the folder-connected instance.
  const launcherDataRoot = join(home.root, "empty-launcher");
  await mkdir(launcherDataRoot);
  await json(join(launcherDataRoot, "config.json"), { homes: [], versions: [], instances: [] });
  const pick = vi.fn(async () => home.homeRoot);
  const engine = await createReadOnlyComposition({ stateRoot, fixturePolicy: assertFixtureSandbox, pickInstanceFolder: pick,
    integrationEnvironment: { launcherDataRoot, installation: { stateRoot, engineEntry: join(home.root, "unused-engine.mjs") } } });
  const server = await startMaintenanceServer({ engine, stateRoot, skipAcl: true });
  cleanups.push(async () => { await server.close(); engine.close(); });
  return { ...home, stateRoot, launcherDataRoot, pick, server };
}

/** A connected instance whose Home is the folder this test selected. */
const instanceId = "i-folder-one";
async function withStandalone(f: Awaited<ReturnType<typeof fixture>>) {
  await writeFile(join(f.stateRoot, "standalone-instances.json"), JSON.stringify([{ schemaVersion: 1, instanceId, profileId: "web",
    name: "Selected folder", runtimeVersion: "0.1.2-rc.1", homeRoot: f.homeRoot, versionRoot: f.versionRoot,
    runtimeUrl: "http://127.0.0.1:19876" }]));
}

it("opens the folder picker only for an authenticated, exact-Origin caller", async () => {
  const f = await fixture();
  const call = (headers: Record<string, string>) => fetch(`${f.server.origin}/v1/integrations/instance-folder`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}",
  });
  expect((await call({})).status).toBe(401);
  expect((await call({ authorization: `Bearer ${f.server.token}`, origin: "https://untrusted.invalid" })).status).toBe(403);
  expect(f.pick).not.toHaveBeenCalled();

  const response = await call({ authorization: `Bearer ${f.server.token}`, origin: f.server.origin });
  expect(response.status).toBe(200);
  const answered = await response.json() as { readonly pendingId?: unknown };
  // The Engine records what it checked, and confirming names that record instead of a path.
  expect(typeof answered.pendingId).toBe("string");
  expect(answered).toMatchObject({ hint: "选择 DSH Home 根目录，其中包含 profiles/ 与 sessions/；同一 Home 下的多个 profile 会被分别识别",
    cancelled: false, inspection: { homeRoot: f.homeRoot, suggestedInstanceId: "my-dsh-home",
      profiles: [{ profileId: "web", root: f.profileRoot, web: true }],
      // The response is parsed by the strict contract schema, so a Home whose folders were all
      // usable carries an explicit empty list of skipped directories.
      skippedEntries: [],
      runtimeVersion: "0.1.2-rc.1", versionRoot: f.versionRoot,
      cliPath: join(f.versionRoot, "node_modules", cliPackage, "lib", "bin.js"), declaredRuntimeVersion: null } });
  // Choosing a folder is a check, not a connection: nothing was registered or written.
  await expect(readFile(join(f.stateRoot, "standalone-instances.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(f.stateRoot, "integration-bindings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(f.stateRoot, "maintenance-required.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("answers a cancelled folder choice without inventing an inspection", async () => {
  const f = await fixture();
  f.pick.mockResolvedValue(null);
  const response = await fetch(`${f.server.origin}/v1/integrations/instance-folder`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${f.server.token}`, origin: f.server.origin }, body: "{}" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ hint: "选择 DSH Home 根目录，其中包含 profiles/ 与 sessions/；同一 Home 下的多个 profile 会被分别识别", cancelled: true });
});

it("reports an unusable folder as a refusal rather than an empty inspection", async () => {
  const f = await fixture();
  const empty = join(f.root, "not-a-home");
  await mkdir(empty);
  f.pick.mockResolvedValue(empty);
  const response = await fetch(`${f.server.origin}/v1/integrations/instance-folder`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${f.server.token}`, origin: f.server.origin }, body: "{}" });
  // The refusal keeps the integration contract's own status and names the check that failed.
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "INSTANCE_FOLDER_INVALID" } });
});

/** POST one takeover request as the authenticated operator. */
function takeover(f: Awaited<ReturnType<typeof fixture>>, body: unknown) {
  return fetch(`${f.server.origin}/v1/integrations/takeover`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${f.server.token}`, origin: f.server.origin },
    body: JSON.stringify(body) });
}

it("reports an instance with no handshake as not takeable, without pretending it is running", async () => {
  const f = await fixture();
  await withStandalone(f);
  const { integrationTargetId } = await import("@linmu/dsh-instance-integration-dsh/launcher-discovery");
  const targetId = integrationTargetId("dsh", f.homeRoot, instanceId, "web");
  const detected = await takeover(f, { targetId, mode: "detect" });
  expect(detected.status).toBe(200);
  expect(await detected.json()).toMatchObject({ handoff: null, lease: { instanceId, profileId: "web", decision: "absent", process: null } });
  // Detection is read-only and a takeover of a stopped instance is refused, not queued.
  const refused = await takeover(f, { targetId, mode: "takeover" });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: { code: "INSTANCE_NOT_RUNNING" } });
  await expect(readFile(join(f.stateRoot, "takeovers", "ticket-one.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses a takeover while the Engine has no run channel, even for a verifiably running instance", async () => {
  const f = await fixture();
  await withStandalone(f);
  const { integrationTargetId } = await import("@linmu/dsh-instance-integration-dsh/launcher-discovery");
  const { writeInstanceLease } = await import("../src/instance-lease.js");
  const { recoverySystemEvidence } = await import("../src/lifecycle-recovery.js");
  const evidence = await recoverySystemEvidence(process.pid);
  // A lease for this very test process: the OS will confirm it is alive.
  await writeInstanceLease(f.stateRoot, { schemaVersion: 1, instanceId, profileId: "web", pid: process.pid,
    processStartedAt: evidence.process!.startedAt, homeRoot: f.homeRoot, runtimeUrl: f.server.origin, state: "idle",
    attachedRunId: null, updatedAt: "2026-09-21T10:00:00.000Z" });
  const targetId = integrationTargetId("dsh", f.homeRoot, instanceId, "web");
  const detected = await takeover(f, { targetId, mode: "detect" });
  expect(detected.status).toBe(200);
  // Verification is real: the lease's process is alive and the challenge reaches this server.
  expect(await detected.json()).toMatchObject({ lease: { decision: "running", process: { pid: process.pid } } });
  // Verification is real: the OS confirms the lease's process is alive, and the
  // liveness challenge actually reaches the engine's own authenticated server,
  // which refuses it. A takeover fails closed on a responder that cannot prove
  // itself, so nothing is prepared and no ticket is written.
  const refused = await takeover(f, { targetId, mode: "takeover" });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: { code: "INSTANCE_HANDSHAKE_REFUSED",
    message: expect.stringContaining("401") } });
  await expect(readFile(join(f.stateRoot, "takeovers", "ticket-none.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("lists only the prepared runs still waiting for this exact instance", async () => {
  const f = await fixture();
  await withStandalone(f);
  const { writeTakeoverHandoff } = await import("../src/instance-lease.js");
  const pending = { schemaVersion: 1 as const, ticketId: "ticket-waiting", instanceId, profileId: "web", runId: "run-waiting",
    runtimeClientId: "plugin-waiting", ownerClientId: "engine-waiting", temporaryPersistenceRootId: "projection:run-waiting",
    maintenanceEndpoint: f.server.origin, dshVersion: "0.1.2-rc.1", adapterId: "dsh-rc1", nativeMode: null,
    createdAt: "2026-09-21T10:00:00.000Z", claimedAt: null };
  await writeTakeoverHandoff(f.stateRoot, pending);
  // A claimed ticket and another instance's ticket must never be offered here.
  await writeTakeoverHandoff(f.stateRoot, { ...pending, ticketId: "ticket-claimed", claimedAt: "2026-09-21T10:05:00.000Z" });
  await writeTakeoverHandoff(f.stateRoot, { ...pending, ticketId: "ticket-other", instanceId: "i-other" });
  const auth = { authorization: `Bearer ${f.server.token}` };
  const list = () => fetch(`${f.server.origin}/v1/integrations/takeovers?${new URLSearchParams({ instanceId, profileId: "web" })}`, { headers: auth });
  const first = await list();
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ takeovers: [{ ticketId: "ticket-waiting", runId: "run-waiting",
    createdAt: "2026-09-21T10:00:00.000Z", claimPath: "/v1/integrations/takeover/ticket-waiting/claim" }] });
  // Polling repeatedly is idempotent: the instance is told the same thing until it claims.
  expect(await (await list()).json()).toEqual(await (await list()).json());
  // Once claimed, the ticket disappears from the poll so the run is never handed out twice.
  expect((await fetch(`${f.server.origin}/v1/integrations/takeover/ticket-waiting/claim`, { method: "POST",
    headers: { ...auth, origin: f.server.origin, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, ticketId: "ticket-waiting", instanceId, profileId: "web", pid: process.pid }) })).status).toBe(200);
  expect(await (await list()).json()).toEqual({ takeovers: [] });
  // The query stays behind the same authentication as every other integration route.
  expect((await fetch(`${f.server.origin}/v1/integrations/takeovers?instanceId=x&profileId=web`)).status).toBe(401);
  // A malformed query is a bad request rather than a silent empty list.
  expect((await fetch(`${f.server.origin}/v1/integrations/takeovers`, { headers: auth })).status).toBe(400);
});

it("hands a synchronisation request to the instance's user and records the first answer", async () => {
  const f = await fixture();
  await withStandalone(f);
  const { writeSyncRequest } = await import("../src/instance-lease.js");
  const auth = { authorization: `Bearer ${f.server.token}` };
  const request = { schemaVersion: 1 as const, requestId: "sync-one", instanceId, profileId: "web",
    summary: "覆盖 3 个会话", requestedAt: "2026-09-21T10:00:00.000Z" };
  await writeSyncRequest(f.stateRoot, request);
  const list = (id = instanceId) => fetch(`${f.server.origin}/v1/integrations/sync-requests?${new URLSearchParams({ instanceId: id, profileId: "web" })}`,
    { headers: auth });
  // Only this instance is told about its own request; another instance sees nothing.
  expect(await (await list()).json()).toEqual({ requests: [request] });
  expect(await (await list("i-other")).json()).toEqual({ requests: [] });
  // The answer is recorded once and the first answer is final: a late approval must
  // not overturn a refusal the user already made.
  const decide = (body: unknown) => fetch(`${f.server.origin}/v1/integrations/sync-requests/sync-one/decision`, { method: "POST",
    headers: { ...auth, origin: f.server.origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  const declined = { schemaVersion: 1, requestId: "sync-one", instanceId, profileId: "web", decision: "declined",
    detail: "用户拒绝了同步", decidedAt: "2026-09-21T10:01:00.000Z" };
  expect((await decide(declined)).status).toBe(200);
  expect(await (await list()).json()).toEqual({ requests: [] });
  const late = await decide({ ...declined, decision: "approved", detail: "迟到的同意" });
  expect(late.status).toBe(409);
  expect(await late.json()).toMatchObject({ error: { code: "INSTANCE_SYNC_DECISION_REFUSED" } });
  // A decision for another instance, or a mismatched request id, is refused outright.
  expect((await decide({ ...declined, instanceId: "i-other", decidedAt: "2026-09-21T10:02:00.000Z" })).status).toBe(409);
  const mismatched = await fetch(`${f.server.origin}/v1/integrations/sync-requests/other-id/decision`, { method: "POST",
    headers: { ...auth, origin: f.server.origin, "content-type": "application/json" }, body: JSON.stringify(declined) });
  expect(mismatched.status).toBe(400);
  // These routes stay behind the same authentication as every other integration route.
  expect((await fetch(`${f.server.origin}/v1/integrations/sync-requests?instanceId=${instanceId}&profileId=web`)).status).toBe(401);
});

it("asks for a synchronisation only when the instance is actually running", async () => {
  const f = await fixture();
  await withStandalone(f);
  const { integrationTargetId } = await import("@linmu/dsh-instance-integration-dsh/launcher-discovery");
  const targetId = integrationTargetId("dsh", f.homeRoot, instanceId, "web");
  // With no handshake there is no running instance, so nothing is written for a user to answer.
  const refused = await fetch(`${f.server.origin}/v1/integrations/sync-requests`, { method: "POST",
    headers: { authorization: `Bearer ${f.server.token}`, origin: f.server.origin, "content-type": "application/json" },
    body: JSON.stringify({ targetId, summary: "覆盖 3 个会话" }) });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: { code: "INSTANCE_NOT_RUNNING" } });
  expect(await (await fetch(`${f.server.origin}/v1/integrations/sync-requests?${new URLSearchParams({ instanceId, profileId: "web" })}`,
    { headers: { authorization: `Bearer ${f.server.token}` } })).json()).toEqual({ requests: [] });
});

it("claims a prepared run exactly once, for the instance it was prepared for", async () => {
  const f = await fixture();
  await withStandalone(f);
  const { writeTakeoverHandoff, takeoverHandoffPath } = await import("../src/instance-lease.js");
  await writeTakeoverHandoff(f.stateRoot, { schemaVersion: 1, ticketId: "ticket-one", instanceId, profileId: "web", runId: "run-one",
    runtimeClientId: "plugin-one", ownerClientId: "engine-one", temporaryPersistenceRootId: "projection:run-one",
    maintenanceEndpoint: f.server.origin, dshVersion: "0.1.2-rc.1", adapterId: "dsh-rc1", nativeMode: null,
    createdAt: "2026-09-21T10:00:00.000Z", claimedAt: null });
  const claim = (body: unknown) => fetch(`${f.server.origin}/v1/integrations/takeover/ticket-one/claim`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${f.server.token}`, origin: f.server.origin },
    body: JSON.stringify(body) });
  const payload = { schemaVersion: 1, ticketId: "ticket-one", instanceId, profileId: "web", pid: process.pid };
  const first = await claim(payload);
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ handoff: { runId: "run-one", runtimeClientId: "plugin-one", claimedAt: expect.any(String) } });
  // The run is single-attach: the same ticket is refused from then on, including after a restart.
  const second = await claim(payload);
  expect(second.status).toBe(409);
  expect(await second.json()).toMatchObject({ error: { code: "INSTANCE_TAKEOVER_REFUSED" } });
  expect(JSON.parse(await readFile(takeoverHandoffPath(f.stateRoot, "ticket-one"), "utf8")).claimedAt).not.toBeNull();
  // Another instance cannot take a run prepared for this one.
  await writeTakeoverHandoff(f.stateRoot, { schemaVersion: 1, ticketId: "ticket-two", instanceId, profileId: "web", runId: "run-two",
    runtimeClientId: "plugin-two", ownerClientId: "engine-two", temporaryPersistenceRootId: "projection:run-two",
    maintenanceEndpoint: f.server.origin, dshVersion: "0.1.2-rc.1", adapterId: "dsh-rc1", nativeMode: null,
    createdAt: "2026-09-21T10:00:00.000Z", claimedAt: null });
  const wrongInstance = await fetch(`${f.server.origin}/v1/integrations/takeover/ticket-two/claim`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${f.server.token}`, origin: f.server.origin },
    body: JSON.stringify({ ...payload, ticketId: "ticket-two", instanceId: "i-someone-else" }) });
  expect(wrongInstance.status).toBe(409);
  // A mismatched ticket path/body is a bad request, not a claim.
  const mismatched = await fetch(`${f.server.origin}/v1/integrations/takeover/ticket-two/claim`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${f.server.token}`, origin: f.server.origin },
    body: JSON.stringify(payload) });
  expect(mismatched.status).toBe(400);
  // Both takeover routes stay behind the same authentication as every other integration route.
  expect((await fetch(`${f.server.origin}/v1/integrations/takeover`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ targetId: "x", mode: "detect" }) })).status).toBe(401);
});
