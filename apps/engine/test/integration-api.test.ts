import { mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { LogicalWorkspace, WorkspaceSyncUpdate } from "@linmu/dsh-session-contracts";
import { SqliteCanonicalRepository } from "@linmu/dsh-session-store";
import { writeCodexFixtureHome } from "../../../packages/test-support/src/index.js";
import { DashboardClient, MaintenanceClient } from "../../../packages/local-api-client/src/index.js";
import { createReadOnlyComposition, probeAndAddInstance } from "../src/composition-root.js";
import { addCodexTarget, loadConfig, updateSettings } from "../src/config.js";
import { startMaintenanceServer } from "../src/http/server.js";
import { createFixtureSystem, hashTree } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixtureApi(name: string, input: {
  readonly registerSource?: boolean;
  readonly defaultHome?: (fixture: Awaited<ReturnType<typeof createFixtureSystem>>) => string | Promise<string>;
} = {}) {
  const fixture = await createFixtureSystem(name);
  cleanups.push(fixture.cleanup);
  const launcherDataRoot = join(fixture.root, "empty-launcher");
  await mkdir(launcherDataRoot);
  const codexHome = await input.defaultHome?.(fixture);
  const options = {
    stateRoot: fixture.stateRoot,
    fixturePolicy: fixture.fixturePolicy,
    integrationEnvironment: {
      launcherDataRoot,
      installation: { stateRoot: fixture.stateRoot, engineEntry: join(fixture.root, "unused-engine.mjs") },
      ...(codexHome === undefined ? {} : { codexHome }),
    },
  };
  if (input.registerSource !== false) await probeAndAddInstance(options, {
    id: "codex-integration-fixture", platform: "codex", displayName: "Synthetic Codex",
    root: fixture.codexHome, platformVersion: "0.146.0",
  });
  const start = async () => {
    const engine = await createReadOnlyComposition(options);
    let closed = false;
    const closeEngine = () => { if (!closed) { closed = true; engine.close(); } };
    cleanups.push(async () => { await engine.writes?.drain(); closeEngine(); });
    const server = await startMaintenanceServer({ engine, stateRoot: fixture.stateRoot, skipAcl: true });
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      await server.close();
      closeEngine();
    };
    cleanups.push(stop);
    return { engine, server, stop, client: new MaintenanceClient({ origin: server.origin, token: server.token }) };
  };
  return { ...fixture, launcherDataRoot, options, start };
}

function requestJson(origin: string, path: string, method: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${origin}${path}`, {
    method, headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("integration and workspace synchronization HTTP contracts", () => {
  it("discovers and registers the default read source, makes imports immediately available, and keeps retries and restarts idempotent", async () => {
    const fixture = await fixtureApi("integration-api-default-source", { registerSource: false, defaultHome: async fixture => {
      const alias = join(fixture.root, "codex-default-alias");
      await symlink(fixture.codexHome, alias, "junction");
      return alias;
    } });
    const sourceBefore = await hashTree(fixture.codexHome);
    const first = await fixture.start();
    expect(await first.engine.listInstances()).toEqual([]);
    expect((await loadConfig(fixture.stateRoot)).instances).toEqual({});
    const directory = await first.client.listIntegrations();
    expect(directory.targets).toHaveLength(1);
    const target = directory.targets[0]!;
    expect(target).toMatchObject({ kind: "codex", name: "本机 Codex", version: "读取协议 0.146.0", status: "available" });
    expect(target.capabilities).toContainEqual(expect.objectContaining({ id: "native-write", status: "unavailable" }));
    expect((await first.client.integrationAction(target.id, "check")).targets[0]!.status).toBe("available");
    expect((await loadConfig(fixture.stateRoot)).instances).toEqual({});
    for (const field of ["path", "root", "codexHome"]) {
      const response = await requestJson(first.server.origin, "/v1/integrations/actions", "POST", {
        targetId: target.id, action: "connect", [field]: fixture.dshHome,
      }, { authorization: `Bearer ${first.server.token}` });
      expect(response.status).toBe(400);
    }
    expect((await loadConfig(fixture.stateRoot)).instances).toEqual({});
    expect((await first.client.integrationAction(target.id, "connect")).targets[0]).toMatchObject({ id: target.id, status: "connected" });
    const instances = await first.engine.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ platform: "codex", compatibility: { status: "compatible" } });
    const instanceId = instances[0]!.id;
    const listed = await fetch(`${first.server.origin}/v1/instances`, { headers: { authorization: `Bearer ${first.server.token}` } });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ instances });
    const savedConfig = await loadConfig(fixture.stateRoot);
    expect(savedConfig.instances[instanceId]).toMatchObject({ root: await realpath(fixture.codexHome), platformVersion: "0.146.0" });
    expect(savedConfig.codexTargets).toEqual({});
    const imported = await first.client.importCodex({ operationId: "default-source-import", instanceIds: [instanceId], mode: "content" });
    await first.server.jobs.waitForImport(imported.id);
    expect(first.engine.repository.database.prepare("SELECT COUNT(*) AS count FROM session_versions").get()).toMatchObject({ count: 1 });
    expect((await first.client.listCodexImports())[0]!.latestEvent?.type).toBe("completed");
    await first.client.integrationAction(target.id, "connect");
    expect(await loadConfig(fixture.stateRoot)).toEqual(savedConfig);
    expect(await first.engine.listInstances()).toHaveLength(1);
    await first.stop();

    const restarted = await fixture.start();
    expect((await restarted.client.listIntegrations()).targets).toEqual(expect.arrayContaining([expect.objectContaining({ id: target.id, status: "connected" })]));
    expect((await restarted.client.listIntegrations()).targets).toHaveLength(1);
    expect(await restarted.engine.listInstances()).toHaveLength(1);
    const reimported = await restarted.client.importCodex({ operationId: "default-source-reimport", instanceIds: [instanceId], mode: "content" });
    await restarted.server.jobs.waitForImport(reimported.id);
    expect(restarted.engine.repository.database.prepare("SELECT COUNT(*) AS count FROM session_versions").get()).toMatchObject({ count: 1 });
    expect((await restarted.client.integrationAction(target.id, "disconnect")).targets[0]!.status).toBe("available");
    expect(await restarted.engine.listInstances()).toHaveLength(1);
    expect(await loadConfig(fixture.stateRoot)).toEqual(savedConfig);
    expect(await hashTree(fixture.codexHome)).toBe(sourceBefore);
  }, 20_000);

  it("deduplicates a default Home alias against registration and preserves other sources, continuation targets, and settings", async () => {
    const fixture = await fixtureApi("integration-api-default-existing", { defaultHome: async fixture => {
      const alias = join(fixture.root, "codex-existing-alias");
      await symlink(fixture.codexHome, alias, "junction");
      return alias;
    } });
    await probeAndAddInstance(fixture.options, { id: "other-dsh", platform: "dsh", displayName: "Other source", root: fixture.dshHome, platformVersion: "0.1.1-rc.2" });
    await addCodexTarget(fixture.stateRoot, { id: "existing-target", codexInstanceId: "codex-integration-fixture", cwd: fixture.root, runtimeWorkspaceRoots: [fixture.root], contextWindowTokens: 120_000, inputBudgetRatio: 0.8 });
    await updateSettings(fixture.stateRoot, { codexInstanceId: "codex-integration-fixture", dshInstanceId: "other-dsh" });
    const before = await loadConfig(fixture.stateRoot);
    const hashes = await Promise.all([hashTree(fixture.codexHome), hashTree(fixture.dshHome)]);
    const runtime = await fixture.start();
    const directory = await runtime.client.listIntegrations();
    expect(directory.targets).toHaveLength(1);
    expect(directory.targets[0]!.name).toBe("Synthetic Codex");
    await runtime.client.integrationAction(directory.targets[0]!.id, "connect");
    expect(await runtime.engine.listInstances()).toHaveLength(2);
    expect(await loadConfig(fixture.stateRoot)).toEqual(before);
    expect(await Promise.all([hashTree(fixture.codexHome), hashTree(fixture.dshHome)])).toEqual(hashes);
  }, 20_000);

  it("adds a new default source without replacing existing registrations or preferences", async () => {
    const fixture = await fixtureApi("integration-api-default-preserve", { defaultHome: async fixture => {
      const home = join(fixture.root, "second-codex");
      await mkdir(home);
      await writeCodexFixtureHome(home);
      return home;
    } });
    await probeAndAddInstance(fixture.options, { id: "other-dsh", platform: "dsh", displayName: "Other source", root: fixture.dshHome, platformVersion: "0.1.1-rc.2" });
    await addCodexTarget(fixture.stateRoot, { id: "existing-target", codexInstanceId: "codex-integration-fixture", cwd: fixture.root, runtimeWorkspaceRoots: [fixture.root], contextWindowTokens: 120_000, inputBudgetRatio: 0.8 });
    await updateSettings(fixture.stateRoot, { codexInstanceId: "codex-integration-fixture", dshInstanceId: "other-dsh" });
    const before = await loadConfig(fixture.stateRoot);
    const sourceRoots = [fixture.codexHome, fixture.dshHome, fixture.options.integrationEnvironment.codexHome!];
    const hashes = await Promise.all(sourceRoots.map(hashTree));
    const runtime = await fixture.start();
    const directory = await runtime.client.listIntegrations();
    expect(directory.targets).toHaveLength(2);
    const candidate = directory.targets.find(target => target.name === "本机 Codex")!;
    await runtime.client.integrationAction(candidate.id, "connect");
    const after = await loadConfig(fixture.stateRoot);
    expect(Object.keys(after.instances)).toHaveLength(3);
    expect(after.instances).toMatchObject(before.instances);
    expect({ ...after, instances: before.instances }).toEqual(before);
    expect(await runtime.engine.listInstances()).toHaveLength(3);
    expect(await Promise.all(sourceRoots.map(hashTree))).toEqual(hashes);
  }, 20_000);

  it("connects the selected registered alias when an earlier ID refers to the same real Codex Home", async () => {
    const fixture = await fixtureApi("integration-api-existing-aliases", { defaultHome: fixture => fixture.codexHome });
    const alias = join(fixture.root, "codex-alias-b");
    await symlink(fixture.codexHome, alias, "junction");
    await probeAndAddInstance(fixture.options, {
      id: "codex-alias-b", platform: "codex", displayName: "Synthetic alias B", root: alias, platformVersion: "0.146.0",
    });
    const before = await readFile(join(fixture.stateRoot, "config.yaml"));
    const sourceBefore = await hashTree(fixture.codexHome);
    const runtime = await fixture.start();
    const directory = await runtime.client.listIntegrations();
    expect(directory.targets).toHaveLength(2);
    const selected = directory.targets.find(target => target.name === "Synthetic alias B")!;
    const connected = await runtime.client.integrationAction(selected.id, "connect");
    expect(connected.targets.find(target => target.id === selected.id)).toMatchObject({ status: "connected" });
    expect(connected.targets.find(target => target.name === "Synthetic Codex")).toMatchObject({ status: "available" });
    expect((await runtime.engine.listInstances()).map(instance => instance.id)).toEqual(["codex-integration-fixture", "codex-alias-b"]);
    expect(await readFile(join(fixture.stateRoot, "config.yaml"))).toEqual(before);
    expect(await hashTree(fixture.codexHome)).toBe(sourceBefore);
  }, 20_000);

  it("scans a newly connected default source immediately through the existing HTTP job path", async () => {
    const fixture = await fixtureApi("integration-api-default-scan", { registerSource: false, defaultHome: fixture => fixture.codexHome });
    const sourceBefore = await hashTree(fixture.codexHome);
    const runtime = await fixture.start();
    const target = (await runtime.client.listIntegrations()).targets[0]!;
    await runtime.client.integrationAction(target.id, "connect");
    const instanceId = (await runtime.engine.listInstances())[0]!.id;
    const job = await runtime.client.scan([instanceId]);
    const events = [];
    for await (const event of runtime.client.subscribe(job.id)) events.push(event);
    expect(events.at(-1)?.type).toBe("completed");
    expect((await runtime.client.listSessions()).items).toHaveLength(1);
    expect(await hashTree(fixture.codexHome)).toBe(sourceBefore);
  }, 20_000);

  it.each(["disabled", "missing", "incompatible"] as const)("handles %s default Home discovery without registering a source", async mode => {
    const fixture = await fixtureApi(`integration-api-default-${mode}`, {
      registerSource: false,
      ...(mode === "disabled" ? {} : { defaultHome: (fixture: Awaited<ReturnType<typeof createFixtureSystem>>) => mode === "missing" ? join(fixture.root, "missing-codex") : fixture.stateRoot }),
    });
    const runtime = await fixture.start();
    const directory = await runtime.client.listIntegrations();
    if (mode === "incompatible") {
      expect(directory.targets).toHaveLength(1);
      expect(directory.targets[0]).toMatchObject({ kind: "codex", status: "unsupported" });
      expect(directory.targets[0]!.issues.length).toBeGreaterThan(0);
      await expect(runtime.client.integrationAction(directory.targets[0]!.id, "connect")).rejects.toThrow("INTEGRATION_UNSUPPORTED");
    } else expect(directory.targets).toEqual([]);
    expect(await runtime.engine.listInstances()).toEqual([]);
    expect((await loadConfig(fixture.stateRoot)).instances).toEqual({});
  }, 20_000);

  it("checks a real registered Codex source, persists its binding, and disconnects without platform writes", async () => {
    const fixture = await fixtureApi("integration-api-binding");
    const sourceBefore = await hashTree(fixture.codexHome);
    const first = await fixture.start();
    const directory = await first.client.listIntegrations();
    expect(directory).toMatchObject({ launcherDetected: false, nativeSyncSupported: false });
    expect(directory.targets).toHaveLength(1);
    const target = directory.targets[0]!;
    expect(target).toMatchObject({ kind: "codex", name: "Synthetic Codex", profile: null, status: "available" });
    expect(target.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "read", status: "supported" }),
      expect.objectContaining({ id: "native-write", status: "unavailable" }),
    ]));
    expect((await first.client.integrationAction(target.id, "check")).targets[0]!.status).toBe("available");
    expect((await first.client.integrationAction(target.id, "connect")).targets[0]!.status).toBe("connected");
    expect((await first.client.integrationAction(target.id, "check")).targets[0]!.status).toBe("connected");
    await first.stop();

    const restarted = await fixture.start();
    expect((await restarted.client.listIntegrations()).targets[0]).toMatchObject({ id: target.id, status: "connected" });
    expect((await restarted.client.integrationAction(target.id, "disconnect")).targets[0]!.status).toBe("available");
    expect((await restarted.client.listIntegrations()).targets[0]!.status).toBe("available");
    await expect(restarted.client.integrationAction("missing-target", "connect")).rejects.toThrow("INTEGRATION_NOT_FOUND");
    expect(await readdir(fixture.launcherDataRoot)).toEqual([]);
    expect(await hashTree(fixture.codexHome)).toBe(sourceBefore);
  }, 20_000);

  it("rechecks source structure instead of keeping a damaged registered source connected", async () => {
    const fixture = await fixtureApi("integration-api-probe");
    const runtime = await fixture.start();
    const target = (await runtime.client.listIntegrations()).targets[0]!;
    await runtime.client.integrationAction(target.id, "connect");
    const rollout = join(fixture.codexHome, "rollouts", "thread-fixture.jsonl");
    const original = await readFile(rollout);
    fixture.fixturePolicy(rollout);
    await writeFile(rollout, `${JSON.stringify({ type: "unrecognized-fixture-envelope" })}\n`);
    const damagedSource = await hashTree(fixture.codexHome);

    const checked = await runtime.client.integrationAction(target.id, "check");
    expect(checked.targets[0]).toMatchObject({ id: target.id, status: "needs-attention" });
    expect(checked.targets[0]!.capabilities).toContainEqual(expect.objectContaining({ id: "read", status: "unavailable" }));
    await expect(runtime.client.integrationAction(target.id, "connect")).rejects.toThrow("INTEGRATION_UNSUPPORTED");
    expect(await hashTree(fixture.codexHome)).toBe(damagedSource);

    await writeFile(rollout, original);
    expect((await runtime.client.integrationAction(target.id, "check")).targets[0]!.status).toBe("connected");
  }, 20_000);

  it("persists future-session scope and rejects concurrent stale, unknown, and forged policy updates", async () => {
    const fixture = await fixtureApi("integration-api-policy");
    const sourceBefore = await hashTree(fixture.codexHome);
    const first = await fixture.start();
    const at = "2026-09-06T00:00:00.000Z";
    const workspace: LogicalWorkspace = {
      schemaVersion: 1, id: "workspace-synthetic" as LogicalWorkspace["id"], parentId: null,
      name: "Synthetic workspace", sortKey: "a", deletedAt: null, createdAt: at, updatedAt: at,
    };
    await first.engine.runWrite("integration-api-workspace-fixture", () =>
      new SqliteCanonicalRepository(first.engine.repository.database).upsertLogicalWorkspace(workspace));
    const initial = await first.client.getWorkspaceSync();
    expect(initial).toMatchObject({ nativeSyncSupported: false, policy: {
      revision: 0, workspaceIds: [], includeFutureSessions: true, nativeWriteEnabled: false,
    } });
    expect(initial.workspaces).toContainEqual(expect.objectContaining({ id: workspace.id, eligible: true, sessionCount: 0 }));
    const saved = await first.client.saveWorkspaceSync({ revision: 0, workspaceIds: [workspace.id] });
    expect(saved.policy).toEqual({ revision: 1, workspaceIds: [workspace.id], includeFutureSessions: true, nativeWriteEnabled: false });

    const updates = await Promise.allSettled([
      first.client.saveWorkspaceSync({ revision: 1, workspaceIds: [workspace.id] }),
      first.client.saveWorkspaceSync({ revision: 1, workspaceIds: [] }),
    ]);
    expect(updates.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = updates.find(result => result.status === "rejected");
    expect(rejected?.status === "rejected" && String(rejected.reason)).toContain("SYNC_POLICY_CHANGED");
    const current = await first.client.getWorkspaceSync();
    expect(current.policy.revision).toBe(2);
    await expect(first.client.saveWorkspaceSync({ revision: 2, workspaceIds: ["unknown-workspace"] })).rejects.toThrow("SYNC_WORKSPACE_UNKNOWN");
    await expect(first.client.saveWorkspaceSync({ revision: 2, workspaceIds: [], nativeWriteEnabled: true } as WorkspaceSyncUpdate)).rejects.toThrow();
    const headers = { authorization: `Bearer ${first.server.token}` };
    for (const extra of [{ nativeWriteEnabled: true }, { includeFutureSessions: false }, { workspaceRoots: [fixture.codexHome] }]) {
      const response = await requestJson(first.server.origin, "/v1/workspace-sync", "PATCH", { revision: 2, workspaceIds: [], ...extra }, headers);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    }
    expect((await first.client.getWorkspaceSync()).policy).toEqual(current.policy);
    const persisted = await first.client.saveWorkspaceSync({ revision: 2, workspaceIds: [workspace.id] });
    await first.stop();
    const restarted = await fixture.start();
    expect((await restarted.client.getWorkspaceSync()).policy).toEqual(persisted.policy);
    expect(persisted.policy).toMatchObject({ revision: 3, workspaceIds: [workspace.id], includeFutureSessions: true, nativeWriteEnabled: false });
    expect(await hashTree(fixture.codexHome)).toBe(sourceBefore);
  }, 20_000);

  it("enforces bearer origin and UI CSRF on every new route and supports the authenticated Dashboard client", async () => {
    const fixture = await fixtureApi("integration-api-auth");
    const sourceBefore = await hashTree(fixture.codexHome);
    const { server, client } = await fixture.start();
    const target = (await client.listIntegrations()).targets[0]!;
    const routes = [
      { path: "/v1/integrations", method: "GET", body: undefined },
      { path: "/v1/integrations/actions", method: "POST", body: { targetId: target.id, action: "connect" } },
      { path: "/v1/workspace-sync", method: "GET", body: undefined },
      { path: "/v1/workspace-sync", method: "PATCH", body: { revision: 0, workspaceIds: [] } },
    ];
    const launch = await client.createDashboardLaunchCode();
    const claim = await fetch(launch.url, { redirect: "manual" });
    expect(claim.status).toBe(303);
    const cookie = claim.headers.get("set-cookie")!.split(";", 1)[0]!;
    const bootstrap = await fetch(`${server.origin}/v1/ui/session`, { headers: { cookie, origin: server.origin } });
    expect(bootstrap.status).toBe(200);
    const session = await bootstrap.json() as { session: { csrfToken: string } };
    for (const route of routes) {
      const call = (headers: Record<string, string>) => requestJson(server.origin, route.path, route.method, route.body, headers);
      expect((await call({})).status).toBe(401);
      expect((await call({ authorization: `Bearer ${server.token}`, origin: "https://untrusted.invalid" })).status).toBe(403);
      expect((await call({ cookie, origin: server.origin })).status).toBe(403);
      expect((await call({ cookie, origin: server.origin, "x-dsh-csrf": "wrong" })).status).toBe(403);
      expect((await call({ cookie, origin: "https://untrusted.invalid", "x-dsh-csrf": session.session.csrfToken })).status).toBe(403);
    }
    expect((await client.listIntegrations()).targets[0]!.status).toBe("available");
    expect((await client.getWorkspaceSync()).policy.revision).toBe(0);
    const malformed = await requestJson(server.origin, "/v1/integrations/actions", "POST", {
      targetId: target.id, action: "connect", root: fixture.codexHome,
    }, { authorization: `Bearer ${server.token}` });
    expect(malformed.status).toBe(400);

    const dashboard = await DashboardClient.connect({
      origin: server.origin,
      fetchImpl: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("cookie", cookie);
        headers.set("origin", server.origin);
        return fetch(input, { ...init, headers });
      },
    });
    expect((await dashboard.listIntegrations()).targets[0]!.id).toBe(target.id);
    expect((await dashboard.integrationAction(target.id, "connect")).targets[0]!.status).toBe("connected");
    expect((await dashboard.getWorkspaceSync()).policy.revision).toBe(0);
    expect((await dashboard.saveWorkspaceSync({ revision: 0, workspaceIds: [] })).policy).toMatchObject({ revision: 1, nativeWriteEnabled: false });
    expect(await hashTree(fixture.codexHome)).toBe(sourceBefore);
  }, 20_000);
});
