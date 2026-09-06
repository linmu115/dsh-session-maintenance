import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureSandbox } from "../../../packages/test-support/src/index.js";
import { MaintenanceWriteCoordinator } from "@linmu/dsh-session-store";
import type { CanonicalWorkspaceDirectory } from "@linmu/dsh-session-contracts";
import { discoverLauncherIntegrations } from "../src/integrations/launcher-discovery.js";
import { InstanceIntegrationService } from "../src/integrations/service.js";
import { readIntegrationBindings } from "../src/integrations/bindings.js";
import { resolveRuntimeIntegration } from "../src/integrations/runtime-binding.js";
import { WorkspaceSyncPolicyService } from "../src/integrations/sync-policy.js";
import { MaintenanceExternalLifecycleProvider } from "../src/external-lifecycle-provider.js";
import { runOfficialCli } from "../src/integrations/launcher-install.js";

const cleanups: Array<() => Promise<void>> = [];
const launcherSha = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function json(path: string, value: unknown) { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify(value)); }
async function fixture(withPlugin = true) {
  const sandbox = await createFixtureSandbox("instance-integration");
  cleanups.push(sandbox.cleanup);
  const stateRoot = join(sandbox.root, "maintenance");
  const dataRoot = join(sandbox.root, "launcher");
  const homeRoot = join(dataRoot, "homes", "a");
  const versionRoot = join(dataRoot, "versions", "rc1");
  const profileRoot = join(homeRoot, "profiles", "web");
  const engineEntry = join(sandbox.root, "engine", "dsh-session-maint.mjs");
  await mkdir(join(engineEntry, ".."), { recursive: true }); await writeFile(engineEntry, "// synthetic");
  const catalog = { homes: [{ id: "home-a", name: "A", path: homeRoot }], versions: [{ id: "version-a", version: "0.1.2-rc.1", dir: versionRoot }], instances: [{ id: "instance-a", name: "DSH A", home_id: "home-a", version_id: "version-a" }, { id: "instance-b", name: "DSH B", home_id: "home-a", version_id: "version-a" }] };
  await json(join(dataRoot, "config.json"), catalog);
  await json(join(dataRoot, "external-lifecycle-capabilities.json"), { schemaVersion: 1, protocolVersion: 1, catalogFile: "config.json", supportedPhases: ["prepare", "beforeStop", "afterExit", "abort"], processId: process.pid, executable: { path: process.execPath, sha256: launcherSha } });
  const profile = () => ({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-web-app", ...(withPlugin ? ["dsh-session-maintenance"] : [])] } } });
  await json(join(profileRoot, "package.json"), profile());
  await json(join(versionRoot, "node_modules", "@deepseek-ai", "dsh", "package.json"), { name: "@deepseek-ai/dsh", version: "0.1.2-rc.1" });
  await mkdir(join(versionRoot, "node_modules", "@deepseek-ai", "dsh", "lib"));
  await writeFile(join(versionRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), "// synthetic");
  for (const name of ["dsh-session", "dsh-session-persistence", "dsh-web-app"]) {
    const root = join(profileRoot, "node_modules", "@deepseek-ai", name);
    await json(join(root, "package.json"), { name: `@deepseek-ai/${name}`, version: "0.1.2-rc.1", main: "index.js", dsh: { bundle: { patch: "./cordis.patch.yml" } } });
    await writeFile(join(root, "index.js"), "// synthetic");
    await writeFile(join(root, "cordis.patch.yml"), "- insert:\n    - id: webserver\n      name: '@deepseek-ai/dsh-webserver'\n");
  }
  const addPlugin = async () => {
    await json(join(profileRoot, "node_modules", "dsh-session-maintenance", "package.json"), { name: "dsh-session-maintenance", version: "0.2.19", main: "index.js", dsh: { bundle: { patch: "./cordis.patch.yml" } } });
    await writeFile(join(profileRoot, "node_modules", "dsh-session-maintenance", "index.js"), "// synthetic plugin");
    await writeFile(join(profileRoot, "node_modules", "dsh-session-maintenance", "cordis.patch.yml"), "- insert:\n    - id: session-maintenance\n      name: dsh-session-maintenance\n");
    await json(join(profileRoot, "package.json"), { dsh: { profile: { bundles: ["@deepseek-ai/dsh-web-app", "dsh-session-maintenance"] } } });
  };
  if (withPlugin) await addPlugin();
  const writes = MaintenanceWriteCoordinator.acquire(stateRoot, "engine");
  cleanups.push(async () => { await writes.drain(); writes.close(); });
  const discover = () => discoverLauncherIntegrations(dataRoot);
  const verifyAdapter = vi.fn(async () => {});
  const installation = { stateRoot, engineEntry };
  const service = new InstanceIntegrationService({ stateRoot, writes, discover, installation, verifyAdapter });
  return { sandbox, stateRoot, dataRoot, homeRoot, versionRoot, profileRoot, engineEntry, catalog, writes, discover, verifyAdapter, installation, service, addPlugin };
}

describe("instance onboarding", () => {
  it("discovers exact instance/profile targets and resolves installed packages instead of trusting catalog versions", async () => {
    const f = await fixture();
    const found = await f.discover();
    expect(found.targets).toHaveLength(2);
    expect(found.targets[0]!.target).toMatchObject({ status: "available", version: "0.1.2-rc.1", profile: "web" });
    expect(found.targets[0]!.target.id).not.toBe(found.targets[1]!.target.id);
    await json(join(f.profileRoot, "node_modules", "@deepseek-ai", "dsh-session", "package.json"), { name: "@deepseek-ai/dsh-session", version: "0.1.2-rc.2", main: "index.js" });
    expect((await f.discover()).targets[0]!.target.status).toBe("unsupported");
  });

  it("saves one binding, leaves another same-version instance disabled, and persists across service restarts", async () => {
    const f = await fixture(); const id = (await f.discover()).targets[0]!.target.id;
    const result = await f.service.action(id, "connect");
    expect(result.targets.map(item => item.status)).toEqual(["connected", "available"]);
    expect(f.verifyAdapter).toHaveBeenCalledTimes(1);
    const hook = JSON.parse(await readFile(join(f.dataRoot, "runtime-lifecycle.json"), "utf8"));
    expect(hook.args).toContain("--require-binding");
    const request = { schemaVersion: 1, phase: "prepare", instanceId: "instance-a", profileId: "web", runtimeVersion: "0.1.2-rc.1", web: true } as const;
    expect(await resolveRuntimeIntegration(f.stateRoot, request)).toMatchObject({ adapterId: "dsh-rc1" });
    expect(await resolveRuntimeIntegration(f.stateRoot, { ...request, instanceId: "instance-b" })).toBeUndefined();
    const next = new InstanceIntegrationService({ stateRoot: f.stateRoot, writes: f.writes, discover: f.discover, installation: f.installation, verifyAdapter: f.verifyAdapter });
    expect((await next.list()).targets[0]!.status).toBe("connected");
    await next.action(id, "disconnect");
    expect(await readIntegrationBindings(f.stateRoot)).toEqual([]);
    expect(await readFile(join(f.profileRoot, "package.json"), "utf8")).toContain("dsh-session-maintenance");
  });

  it("fails closed before Engine discovery when scoped launch has no binding", async () => {
    const f = await fixture(); const connection = vi.fn(async () => { throw new Error("must not connect"); });
    const provider = new MaintenanceExternalLifecycleProvider(f.stateRoot, { requireBinding: true, connection });
    expect(await provider.handle({ schemaVersion: 1, phase: "prepare", instanceId: "instance-b", profileId: "web", runtimeVersion: "0.1.2-rc.1", web: true })).toMatchObject({ enabled: false });
    expect(connection).not.toHaveBeenCalled();
  });

  it("requires repair after changes and keeps an unknown Hook intact", async () => {
    const f = await fixture(); const id = (await f.discover()).targets[0]!.target.id;
    const hookPath = join(f.dataRoot, "runtime-lifecycle.json");
    const unknown = { schemaVersion: 1, program: process.execPath, args: ["another-provider.mjs"], timeoutMs: 30000 };
    await json(hookPath, unknown);
    await expect(f.service.action(id, "connect")).rejects.toMatchObject({ code: "LAUNCHER_HOOK_CONFLICT" });
    expect(JSON.parse(await readFile(hookPath, "utf8"))).toEqual(unknown);
    expect(await readIntegrationBindings(f.stateRoot)).toEqual([]);
  });

  it("preserves the existing trace wrapper while adopting scoped startup", async () => {
    const f = await fixture(); const id = (await f.discover()).targets[0]!.target.id;
    const previous = join(f.sandbox.root, "previous", "engine", "dsh-session-maint.mjs");
    await mkdir(join(previous, ".."), { recursive: true }); await writeFile(previous, "// synthetic previous engine");
    await json(join(f.sandbox.root, "previous", "BUILD-INFO.json"), { schemaVersion: 1, protocolVersions: { externalLifecycle: 1 }, components: [{ name: "@linmu/dsh-session-maintenance-engine" }] });
    const prefix = [fileURLToPath(new URL("./fixtures/trace-external-lifecycle.mjs", import.meta.url)), "--trace-file", join(f.sandbox.root, "trace.log"), "--", process.execPath];
    await json(join(f.dataRoot, "runtime-lifecycle.json"), { schemaVersion: 1, program: process.execPath, args: [...prefix, previous, "--state-root", f.stateRoot, "external-lifecycle"], timeoutMs: 300000 });
    await f.service.action(id, "connect");
    const hook = JSON.parse(await readFile(join(f.dataRoot, "runtime-lifecycle.json"), "utf8"));
    expect(hook.args.slice(0, 5)).toEqual(prefix);
    expect(hook.args[5]).toBe(f.engineEntry);
  });

  it("refuses another provider even when it is named main.js and uses the same arguments", async () => {
    const f = await fixture(); const id = (await f.discover()).targets[0]!.target.id;
    const entry = join(f.sandbox.root, "other", "dist", "main.js");
    await mkdir(join(entry, ".."), { recursive: true }); await writeFile(entry, "// other provider");
    await json(join(f.sandbox.root, "other", "package.json"), { name: "another-provider" });
    const hook = { schemaVersion: 1, program: process.execPath, args: [entry, "--state-root", f.stateRoot, "external-lifecycle"] };
    await json(join(f.dataRoot, "runtime-lifecycle.json"), hook);
    await expect(f.service.action(id, "connect")).rejects.toMatchObject({ code: "LAUNCHER_HOOK_CONFLICT" });
    expect(JSON.parse(await readFile(join(f.dataRoot, "runtime-lifecycle.json"), "utf8"))).toEqual(hook);
  });

  it("requires a verified Launcher binary and rechecks upgrades before launch", async () => {
    const f = await fixture(); const id = (await f.discover()).targets[0]!.target.id;
    await f.service.action(id, "connect");
    const receiptPath = join(f.dataRoot, "external-lifecycle-capabilities.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    await json(receiptPath, { ...receipt, executable: { ...receipt.executable, sha256: createHash("sha256").update("previous binary").digest("hex") } });
    expect((await f.service.list()).targets[0]!.status).toBe("needs-attention");
    await expect(resolveRuntimeIntegration(f.stateRoot, { schemaVersion: 1, phase: "prepare", instanceId: "instance-a", profileId: "web", runtimeVersion: "0.1.2-rc.1", web: true })).rejects.toMatchObject({ code: "INTEGRATION_RECHECK_REQUIRED" });
    await unlink(join(f.dataRoot, "external-lifecycle-capabilities.json"));
    await expect(f.service.action(id, "repair")).rejects.toMatchObject({ code: "INTEGRATION_UNSUPPORTED" });
  });

  it("refuses disabled session services and fingerprints both effective user patch layers", async () => {
    const f = await fixture(); const id = (await f.discover()).targets[0]!.target.id;
    await f.service.action(id, "connect");
    await writeFile(join(f.profileRoot, "cordis.patch.yml"), "- id: unrelated-plugin\n  config:\n    theme: dark\n");
    expect((await f.service.list()).targets[0]!.status).toBe("needs-attention");
    expect((await f.service.action(id, "repair")).targets[0]!.status).toBe("connected");
    await writeFile(join(f.homeRoot, "cordis.patch.yml"), "- id: session-maintenance\n  disabled: true\n");
    await expect(f.service.action(id, "repair")).rejects.toMatchObject({ code: "INTEGRATION_UNSUPPORTED" });
    await writeFile(join(f.homeRoot, "cordis.patch.yml"), "- id: session-persistence-jsonl\n  disabled: true\n");
    expect((await f.discover()).targets[0]!.target.status).toBe("unsupported");
    await writeFile(join(f.homeRoot, "cordis.patch.yml"), "- id: webserver\n  disabled: true\n");
    expect((await f.discover()).targets[0]!.target.status).toBe("unsupported");
  });

  it("does not claim an installed plugin entry or Web app when they cannot load", async () => {
    const f = await fixture();
    await unlink(join(f.profileRoot, "node_modules", "dsh-session-maintenance", "index.js"));
    expect((await f.discover()).targets[0]!.pluginReady).toBe(false);
    await f.addPlugin();
    await json(join(f.profileRoot, "package.json"), { dsh: { profile: { bundles: ["dsh-session-maintenance"] } } });
    expect((await f.discover()).targets[0]!.target.status).toBe("unsupported");
  });

  it("finds built-in Web bundles from the CLI before any profile has been launched", async () => {
    const f = await fixture();
    const previous = join(f.profileRoot, "node_modules", "@deepseek-ai", "dsh-web-app");
    const installed = join(f.versionRoot, "node_modules", "@deepseek-ai", "dsh-web-app");
    await mkdir(installed, { recursive: true });
    for (const file of ["package.json", "index.js", "cordis.patch.yml"]) {
      await writeFile(join(installed, file), await readFile(join(previous, file)));
      await unlink(join(previous, file));
    }
    const target = (await f.discover()).targets[0]!;
    expect(target.target.status).toBe("available");
    expect((await f.service.action(target.target.id, "connect")).targets[0]!.status).toBe("connected");
  });

  it("requires an actual enabled Maintenance bundle and its patch file", async () => {
    const f = await fixture(); const target = (await f.discover()).targets[0]!;
    await f.service.action(target.target.id, "connect");
    const patch = join(f.profileRoot, "node_modules", "dsh-session-maintenance", "cordis.patch.yml");
    await unlink(patch);
    expect((await f.discover()).targets[0]!.pluginReady).toBe(false);
    expect((await f.service.list()).targets[0]!.status).toBe("needs-attention");
    await writeFile(patch, "[]");
    expect((await f.discover()).targets[0]!.pluginReady).toBe(false);
    await f.addPlugin();
    expect((await f.discover()).targets[0]!.pluginReady).toBe(true);
  });

  it("keeps a broken unrelated profile isolated from valid connections and launches", async () => {
    const f = await fixture(); const target = (await f.discover()).targets[0]!;
    await f.service.action(target.target.id, "connect");
    await mkdir(join(f.homeRoot, "profiles", "broken"));
    await writeFile(join(f.homeRoot, "profiles", "broken", "package.json"), "{ malformed");
    const list = await f.service.list();
    expect(list.targets.find(item => item.id === target.target.id)?.status).toBe("connected");
    expect(list.targets.find(item => item.profile === "broken")?.status).toBe("unsupported");
    expect(await resolveRuntimeIntegration(f.stateRoot, { schemaVersion: 1, phase: "prepare", instanceId: "instance-a", profileId: "web", runtimeVersion: "0.1.2-rc.1", web: true })).toMatchObject({ adapterId: "dsh-rc1" });
  });

  it("refuses a stale receipt pointing to a different executable from its live process", async () => {
    const f = await fixture();
    const receiptPath = join(f.dataRoot, "external-lifecycle-capabilities.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    const oldExe = join(f.sandbox.root, "previous-launcher.exe"); await writeFile(oldExe, "previous launcher");
    await json(receiptPath, { ...receipt, executable: { path: oldExe, sha256: createHash("sha256").update("previous launcher").digest("hex") } });
    expect((await f.discover()).targets[0]!.target.status).toBe("unsupported");
  });

  it("stops its own installation process tree on timeout before returning", async () => {
    const f = await fixture();
    const marker = join(f.sandbox.root, "descendant.pid");
    const childCode = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)";
    const parentCode = "require('node:child_process').spawn(process.execPath, ['-e', process.argv[1], process.argv[2]], {stdio:'ignore', windowsHide:true}); setInterval(() => {}, 1000)";
    await expect(runOfficialCli(process.execPath, ["-e", parentCode, childCode, marker], { cwd: f.sandbox.root, env: process.env }, 1500)).rejects.toMatchObject({ code: "INTEGRATION_INSTALL_TIMEOUT" });
    const pid = Number(await readFile(marker, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("detects changed package identity before launch and repairs only after verification", async () => {
    const f = await fixture(); const id = (await f.discover()).targets[0]!.target.id;
    await f.service.action(id, "connect");
    await json(join(f.profileRoot, "node_modules", "dsh-session-maintenance", "package.json"), { name: "dsh-session-maintenance", version: "0.2.20", main: "index.js", dsh: { bundle: { patch: "./cordis.patch.yml" } } });
    expect((await f.service.list()).targets[0]!.status).toBe("needs-attention");
    await expect(resolveRuntimeIntegration(f.stateRoot, { schemaVersion: 1, phase: "prepare", instanceId: "instance-a", profileId: "web", runtimeVersion: "0.1.2-rc.1", web: true })).rejects.toMatchObject({ code: "INTEGRATION_RECHECK_REQUIRED" });
    expect((await f.service.action(id, "repair")).targets[0]!.status).toBe("connected");
  });

  it("uses the selected official CLI and checks artifacts, publishing only after successful installation", async () => {
    const f = await fixture(false); const id = (await f.discover()).targets[0]!.target.id;
    const path = join(f.sandbox.root, "plugin.tgz"); await writeFile(path, "synthetic package");
    const run = vi.fn(async () => { await f.addPlugin(); });
    const service = new InstanceIntegrationService({ stateRoot: f.stateRoot, writes: f.writes, discover: f.discover, verifyAdapter: f.verifyAdapter,
      installation: { ...f.installation, artifact: { path, sha256: createHash("sha256").update("synthetic package").digest("hex") }, run } });
    expect((await service.action(id, "connect")).targets[0]!.status).toBe("connected");
    expect(run).toHaveBeenCalledWith(process.execPath, expect.arrayContaining(["plugin", "--profile", "web", "add", path]), expect.objectContaining({ cwd: f.versionRoot, env: expect.objectContaining({ DSH_HOME: f.homeRoot }) }));
  });

  it("keeps install failure unbound and allows unrelated canonical writes while installing", async () => {
    const f = await fixture(false); const id = (await f.discover()).targets[0]!.target.id;
    const path = join(f.sandbox.root, "plugin.tgz"); await writeFile(path, "synthetic");
    const run = async () => { await f.writes.run("ordinary-append", async () => {}); throw new Error("synthetic installer failed"); };
    const service = new InstanceIntegrationService({ stateRoot: f.stateRoot, writes: f.writes, discover: f.discover, verifyAdapter: f.verifyAdapter,
      installation: { ...f.installation, artifact: { path, sha256: createHash("sha256").update("synthetic").digest("hex") }, run } });
    await expect(service.action(id, "connect")).rejects.toThrow("synthetic installer failed");
    expect(await readIntegrationBindings(f.stateRoot)).toEqual([]);
  });

  it("rejects duplicate catalog IDs and allows disconnecting removed targets", async () => {
    const f = await fixture(); const id = (await f.discover()).targets[0]!.target.id;
    await f.service.action(id, "connect");
    await json(join(f.dataRoot, "config.json"), { ...f.catalog, instances: [] });
    expect((await f.service.list()).targets[0]!.status).toBe("needs-attention");
    await f.service.action(id, "disconnect");
    expect((await f.service.list()).targets).toHaveLength(0);
    await json(join(f.dataRoot, "config.json"), { ...f.catalog, instances: [f.catalog.instances[0], f.catalog.instances[0]] });
    await expect(f.discover()).rejects.toMatchObject({ code: "LAUNCHER_CATALOG_INVALID" });
  });

  it("does not reconnect after a disconnect that completed during a slow install", async () => {
    const f = await fixture(false); const id = (await f.discover()).targets[0]!.target.id;
    const path = join(f.sandbox.root, "plugin.tgz"); await writeFile(path, "synthetic");
    let release!: () => void; let started!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const running = new Promise<void>(resolve => { started = resolve; });
    const service = new InstanceIntegrationService({ stateRoot: f.stateRoot, writes: f.writes, discover: f.discover, verifyAdapter: f.verifyAdapter,
      installation: { ...f.installation, artifact: { path, sha256: createHash("sha256").update("synthetic").digest("hex") }, run: async () => { started(); await pending; await f.addPlugin(); } } });
    const connecting = service.action(id, "connect").catch(error => error);
    await running;
    await service.action(id, "disconnect");
    release();
    expect(await connecting).toMatchObject({ code: "INTEGRATION_CANCELLED" });
    expect(await readIntegrationBindings(f.stateRoot)).toEqual([]);
  });

  it("keeps a disconnect that finished while an earlier connect was still discovering", async () => {
    const f = await fixture(); const id = (await f.discover()).targets[0]!.target.id;
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const running = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    const discover = async () => { if (calls++ === 0) { started(); await gate; } return f.discover(); };
    const service = new InstanceIntegrationService({ stateRoot: f.stateRoot, writes: f.writes, discover, installation: f.installation, verifyAdapter: f.verifyAdapter });
    const connecting = service.action(id, "connect").catch(error => error);
    await running;
    await service.action(id, "disconnect");
    release();
    expect(await connecting).toMatchObject({ code: "INTEGRATION_CANCELLED" });
    expect(await readIntegrationBindings(f.stateRoot)).toEqual([]);
  });
});

describe("workspace sync policy", () => {
  it("persists revisions and future inclusion while refusing unknown scope or native write enablement", async () => {
    const f = await fixture();
    const directory = { schemaVersion: 1, unclassified: [], workspaces: [{ workspace: { id: "workspace-a", name: "A", deletedAt: null }, sessions: [] }] } as unknown as CanonicalWorkspaceDirectory;
    const service = new WorkspaceSyncPolicyService({ stateRoot: f.stateRoot, writes: f.writes, directory: () => directory });
    const saved = await service.save({ revision: 0, workspaceIds: ["workspace-a"] });
    expect(saved.policy).toEqual({ revision: 1, workspaceIds: ["workspace-a"], includeFutureSessions: true, nativeWriteEnabled: false });
    await expect(service.save({ revision: 0, workspaceIds: [] })).rejects.toMatchObject({ code: "SYNC_POLICY_CHANGED" });
    await expect(service.save({ revision: 1, workspaceIds: ["workspace-other"] })).rejects.toMatchObject({ code: "SYNC_WORKSPACE_UNKNOWN" });
    await expect(service.save({ revision: 1, workspaceIds: [], nativeWriteEnabled: true } as never)).rejects.toThrow();
    const reloaded = new WorkspaceSyncPolicyService({ stateRoot: f.stateRoot, writes: f.writes, directory: () => directory });
    expect((await reloaded.get()).policy).toEqual(saved.policy);
    expect((await service.save({ revision: 1, workspaceIds: [] })).policy).toMatchObject({ revision: 2, workspaceIds: [], nativeWriteEnabled: false });
  });
});
