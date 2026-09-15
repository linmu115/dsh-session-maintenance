import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MaintenanceClient } from "../../../packages/local-api-client/src/index.js";
import { saveIntegrationBindings, type InstanceIntegrationBinding } from "../src/integrations/bindings.js";
import { InstanceIntegrationService } from "../src/integrations/service.js";
import { createEngineFixture } from "./helpers.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const plugins = [{ namespace: "annotation-records", pluginVersion: "0.3.12-rc2.10", writerId: "dsh-annotation-core" }];
function binding(root: string, instanceId = "dynamic-copy", profileId = "web"): InstanceIntegrationBinding {
  return { targetId: `${instanceId}-${profileId}`, kind: "dsh", instanceId, profileId, launcherDataRoot: root,
    runtimeVersion: "0.1.5-rc.2", adapterId: "dsh-0.1.5", fingerprint: "synthetic", checkedAt: "2026-09-15T00:00:00.000Z" };
}

describe("extension panel instance display names", () => {
  it("returns the bound dynamic Launcher name through the real route without requiring a registered source", async () => {
    const f = await createEngineFixture("synthetic-extension-launcher-label"); cleanup.push(f.cleanupAll);
    const root = join(f.root, "synthetic-launcher"); await mkdir(root);
    const catalogPath = join(root, "config.json");
    // No runtime, package, home or attestation files: displaying a name needs only the bound catalog.
    const catalog = JSON.stringify({ instances: [{ id: "dynamic-copy", name: "0.1.5-rc.2 副本", env_overrides: { PRIVATE: "not-response-data" } }] });
    await writeFile(catalogPath, catalog);
    await saveIntegrationBindings(f.stateRoot, [binding(root)]);
    expect(f.engine.instances.some(instance => instance.id === "dynamic-copy")).toBe(false);
    for (const scope of [{ instanceId: "dynamic-copy", profileId: "web" }, { instanceId: "dynamic-copy", profileId: "other" },
      { instanceId: "codex-fixture", profileId: "web" }, { instanceId: "missing-copy", profileId: "web" }]) {
      await f.engine.runWrite("synthetic-extension-label", () => f.engine.extensions!.connect({ ...scope, plugins }));
    }
    const list = vi.spyOn(f.engine.integrations!, "list");
    const server = await f.startServer(), client = new MaintenanceClient({ origin: server.origin, token: server.token });
    const panels = await client.listExtensionBusinessPanels();
    expect(panels.find(panel => panel.scope.instanceId === "dynamic-copy" && panel.scope.profileId === "web")?.instanceLabel).toBe("0.1.5-rc.2 副本");
    expect(panels.find(panel => panel.scope.instanceId === "dynamic-copy" && panel.scope.profileId === "other")?.instanceLabel).toBe("dynamic-copy");
    expect(panels.find(panel => panel.scope.instanceId === "codex-fixture")?.instanceLabel).toBe("Codex fixture");
    expect(panels.find(panel => panel.scope.instanceId === "missing-copy")?.instanceLabel).toBe("missing-copy");
    expect(list).not.toHaveBeenCalled(); expect(JSON.stringify(panels)).not.toContain("not-response-data");
    expect(await readFile(catalogPath, "utf8")).toBe(catalog);
  });

  it("reuses the lightweight cache, refreshes renamed instances, and falls back for invalid or ambiguous catalogs", async () => {
    const f = await createEngineFixture("synthetic-extension-label-cache"); cleanup.push(f.cleanupAll);
    const root = join(f.root, "synthetic-launcher"); await mkdir(root);
    const path = join(root, "config.json");
    await writeFile(path, JSON.stringify({ instances: [{ id: "dynamic-copy", name: "原名" }] }));
    await saveIntegrationBindings(f.stateRoot, [binding(root)]);
    const discover = vi.fn(async () => { throw new Error("Display labels must not scan the host"); });
    const service = new InstanceIntegrationService({ stateRoot: f.stateRoot, writes: { run: async (_kind, work) => work() },
      discover, verifyAdapter: async () => {}, installation: { stateRoot: f.stateRoot, engineEntry: join(f.root, "unused.mjs") } });
    const now = vi.spyOn(Date, "now").mockReturnValue(10000);
    expect(await Promise.all([service.instanceDisplayName("dynamic-copy", "web"), service.instanceDisplayName("dynamic-copy", "web")])).toEqual(["原名", "原名"]);
    await writeFile(path, JSON.stringify({ instances: [{ id: "dynamic-copy", name: "新名称" }] }));
    expect(await service.instanceDisplayName("dynamic-copy", "web")).toBe("原名");
    now.mockReturnValue(16000);
    expect(await service.instanceDisplayName("dynamic-copy", "web")).toBe("新名称");
    await writeFile(path, JSON.stringify({ instances: [{ id: "dynamic-copy", name: "甲" }, { id: "dynamic-copy", name: "乙" }] }));
    now.mockReturnValue(22000);
    expect(await service.instanceDisplayName("dynamic-copy", "web")).toBeUndefined();
    await writeFile(path, "invalid json"); now.mockReturnValue(28000);
    expect(await service.instanceDisplayName("dynamic-copy", "web")).toBeUndefined();
    expect(discover).not.toHaveBeenCalled();
  });
});
