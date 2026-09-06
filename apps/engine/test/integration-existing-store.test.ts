import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, parse as parsePath } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureSandbox } from "../../../packages/test-support/src/index.js";
import type { DiscoveredIntegration } from "../src/integrations/launcher-discovery.js";
import { installIntegrationPlugin } from "../src/integrations/launcher-install.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const sandbox = await createFixtureSandbox("integration-existing-store");
  cleanups.push(sandbox.cleanup);
  const launcherDataRoot = join(sandbox.root, "launcher");
  const homeRoot = join(launcherDataRoot, "homes", "synthetic");
  const profileRoot = join(homeRoot, "profiles", "web");
  const versionRoot = join(launcherDataRoot, "versions", "rc1");
  await mkdir(profileRoot, { recursive: true });
  await mkdir(versionRoot, { recursive: true });
  const artifactPath = join(sandbox.root, "synthetic-plugin.tgz");
  const artifactBytes = Buffer.from("synthetic fixture artifact; never executed");
  await writeFile(artifactPath, artifactBytes);
  const target: DiscoveredIntegration = {
    target: { id: "target-fixture", kind: "dsh", name: "合成实例", version: "0.1.2-rc.1", profile: "web",
      status: "available", adapterId: "dsh-rc1", capabilities: [], issues: [] },
    instanceId: "instance-fixture", fingerprint: "fixture-fingerprint", launcherDataRoot, homeRoot,
    profileRoot, versionRoot, cliPath: join(versionRoot, "synthetic-cli.js"), packageVersions: {}, pluginReady: false,
  };
  const run = vi.fn(async (_program: string, _args: string[], _options: { cwd: string; env: NodeJS.ProcessEnv }) => undefined);
  const options = { stateRoot: join(sandbox.root, "state"), engineEntry: join(sandbox.root, "synthetic-engine.js"),
    artifact: { path: artifactPath, sha256: createHash("sha256").update(artifactBytes).digest("hex") }, run };
  const recordPath = join(profileRoot, "node_modules", ".modules.yaml");
  const sentinel = join(profileRoot, "node_modules", "keep-existing-dependencies.txt");
  const writeRecord = async (text: string) => {
    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(recordPath, text);
    await writeFile(sentinel, "existing modules must remain intact");
  };
  return { ...sandbox, target, options, run, recordPath, sentinel, writeRecord };
}

describe("integration installation reuses the profile's existing pnpm store", () => {
  it("accepts the existing system-store JSON record without adding a second version suffix", async () => {
    const sample = await fixture();
    // This is a synthetic system-store path inside the marked sandbox. The
    // installer must only pass it to the stubbed CLI, never inspect its files.
    const effectiveStore = join(sample.root, "Users", "Fixture", "AppData", "Local", "pnpm", "store", "v11");
    const record = JSON.stringify({ layoutVersion: 5, packageManager: "pnpm@11.19.0", storeDir: effectiveStore, hoistedDependencies: {} });
    await sample.writeRecord(record);
    await installIntegrationPlugin(sample.target, sample.options);
    expect(sample.run).toHaveBeenCalledOnce();
    expect(sample.run.mock.calls[0]?.[1]).toEqual([sample.target.cliPath, "plugin", "--profile", "web", "add", sample.options.artifact.path,
      "--store-dir", dirname(effectiveStore), "--loglevel=info"]);
    expect(sample.run.mock.calls[0]?.[2]).toMatchObject({ cwd: sample.target.versionRoot, env: { DSH_HOME: sample.target.homeRoot, CI: "true" } });
    expect(await readFile(sample.recordPath, "utf8")).toBe(record);
    expect(await readFile(sample.sentinel, "utf8")).toBe("existing modules must remain intact");
  });

  it("accepts an independent custom-store YAML record and normalizes the trailing separator", async () => {
    const sample = await fixture();
    const effectiveStore = `${join(sample.root, "independent cache with spaces", "v11")}/`;
    const record = `layoutVersion: 5\nstoreDir: ${JSON.stringify(effectiveStore)}\nhoistedDependencies: {}\n`;
    await sample.writeRecord(record);
    await installIntegrationPlugin(sample.target, sample.options);
    const args = sample.run.mock.calls[0]![1];
    expect(args[args.indexOf("--store-dir") + 1]).toBe(join(sample.root, "independent cache with spaces"));
    expect(await readFile(sample.recordPath, "utf8")).toBe(record);
    expect(await readFile(sample.sentinel, "utf8")).toBe("existing modules must remain intact");
  });

  it("retains the launcher-local fallback for a fresh profile with no modules record", async () => {
    const sample = await fixture();
    await installIntegrationPlugin(sample.target, sample.options);
    const args = sample.run.mock.calls[0]![1];
    expect(args[args.indexOf("--store-dir") + 1]).toBe(join(sample.target.launcherDataRoot!, ".pnpm-store"));
    await expect(readFile(sample.recordPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["malformed YAML", "storeDir: [broken"],
    ["missing storeDir", "layoutVersion: 5\n"],
    ["non-string path", "storeDir: 11\n"],
    ["empty path", "storeDir: ''\n"],
    ["relative path", "storeDir: .pnpm-store/v11\n"],
    ["duplicate store keys", "storeDir: /first/v11\nstoreDir: /second/v11\n"],
    ["invalid document root", "- storeDir: /cache/v11\n"],
    ["unsupported aliases", "value: &cache /cache/v11\nstoreDir: *cache\n"],
  ])("fails explainably for %s without removing existing modules or invoking the installer", async (_name, record) => {
    const sample = await fixture();
    await sample.writeRecord(record);
    await expect(installIntegrationPlugin(sample.target, sample.options)).rejects.toMatchObject({
      code: "INTEGRATION_STORE_RECORD_INVALID", message: expect.stringContaining("pnpm 缓存记录"),
    });
    expect(sample.run).not.toHaveBeenCalled();
    expect(await readFile(sample.recordPath, "utf8")).toBe(record);
    expect(await readFile(sample.sentinel, "utf8")).toBe("existing modules must remain intact");
  });

  it("rejects abnormal absolute store paths instead of guessing a different cache", async () => {
    const sample = await fixture();
    const paths = [join(sample.root, "no-version-suffix"), `${sample.root}/cache/../other/v11`,
      join(parsePath(sample.root).root, "v11"), `${sample.root}/cache\u0000/v11`, ` ${join(sample.root, "cache", "v11")}`];
    for (const storeDir of paths) {
      await sample.writeRecord(JSON.stringify({ storeDir }));
      await expect(installIntegrationPlugin(sample.target, sample.options)).rejects.toMatchObject({ code: "INTEGRATION_STORE_RECORD_INVALID" });
    }
    expect(sample.run).not.toHaveBeenCalled();
    expect(await readFile(sample.sentinel, "utf8")).toBe("existing modules must remain intact");
  });

  it("rejects a directory or oversized modules record without starting installation", async () => {
    const directory = await fixture();
    await mkdir(directory.recordPath, { recursive: true });
    await expect(installIntegrationPlugin(directory.target, directory.options)).rejects.toMatchObject({ code: "INTEGRATION_STORE_RECORD_INVALID" });
    expect(directory.run).not.toHaveBeenCalled();
    const oversized = await fixture();
    await oversized.writeRecord(" ".repeat(4 * 1024 * 1024 + 1));
    await expect(installIntegrationPlugin(oversized.target, oversized.options)).rejects.toMatchObject({ code: "INTEGRATION_STORE_RECORD_INVALID" });
    expect(oversized.run).not.toHaveBeenCalled();
  });

  it("still checks the artifact digest before any install command", async () => {
    const sample = await fixture();
    await sample.writeRecord(JSON.stringify({ storeDir: join(sample.root, "cache", "v11") }));
    await expect(installIntegrationPlugin(sample.target, { ...sample.options,
      artifact: { ...sample.options.artifact, sha256: "0".repeat(64) } })).rejects.toMatchObject({ code: "INTEGRATION_PACKAGE_CHANGED" });
    expect(sample.run).not.toHaveBeenCalled();
  });
});
