import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { parseDocument } from "yaml";
import { inspectDshIntegrationOverrides, maintenanceIntegrationBundleReady } from "@linmu/dsh-adapter-dsh";
import type { AdapterProbe, IntegrationTarget, RegisteredInstance } from "@linmu/dsh-session-contracts";
import { IntegrationError, readJsonIfPresent } from "./bindings.js";
import { inspectLauncherCapabilities } from "./launcher-capabilities.js";

const catalogSchema = z.object({
  homes: z.array(z.object({ id: z.string(), name: z.string(), path: z.string() })),
  versions: z.array(z.object({ id: z.string(), version: z.string(), dir: z.string() })),
  instances: z.array(z.object({ id: z.string(), name: z.string(), home_id: z.string(), version_id: z.string(), env_overrides: z.record(z.string(), z.string()).optional() })),
});
export const SUPPORTED_DSH_INTEGRATIONS: Readonly<Record<string, string>> = {
  "0.1.2-alpha.2": "dsh-alpha2", "0.1.2-rc.1": "dsh-rc1",
};
export interface DiscoveredIntegration {
  readonly target: IntegrationTarget;
  readonly instanceId: string;
  readonly fingerprint: string;
  readonly launcherDataRoot: string | null;
  readonly homeRoot: string;
  readonly versionRoot: string | null;
  readonly profileRoot: string | null;
  readonly cliPath: string | null;
  readonly packageVersions: Readonly<Record<string, string>>;
  readonly pluginReady: boolean;
  readonly codexSource?: RegisteredInstance;
  readonly codexRegistered?: boolean;
}
export interface DiscoveredIntegrations { readonly launcherDetected: boolean; readonly targets: DiscoveredIntegration[] }
const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export function integrationTargetId(kind: string, scope: string, instanceId: string, profileId: string | null): string {
  return `${kind}-${createHash("sha256").update(JSON.stringify([scope, instanceId, profileId])).digest("hex").slice(0, 32)}`;
}
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function unique<T extends { id: string }>(items: T[], label: string): void {
  if (new Set(items.map(item => item.id)).size !== items.length) throw new IntegrationError("LAUNCHER_CATALOG_INVALID", `${label}存在重复标识，无法确定接入对象。`, 503);
}
export async function ownedRealpath(parent: string, path: string): Promise<string> {
  const [root, actual] = await Promise.all([realpath(parent), realpath(path)]);
  const suffix = relative(root, actual);
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new IntegrationError("INTEGRATION_PATH_CHANGED", "接入路径已越出所选实例，请重新检查。", 409);
  return actual;
}
async function packageVersion(path: string): Promise<string | null> {
  const value = await readJsonIfPresent(path);
  if (value === undefined) return null;
  const parsed = z.object({ version: z.string().min(1) }).safeParse(value);
  return parsed.success ? parsed.data.version : null;
}
function compatiblePlugin(version: string | null): boolean {
  return version === "0.2.19" || version === "0.2.20";
}

function withinRoots(path: string, roots: readonly string[]): boolean {
  return roots.some(root => { const part = relative(root, path); return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); });
}
async function resolvePackage(anchor: string, name: string, roots: readonly string[]): Promise<{ path: string; version: string } | null> {
  try {
    const require = createRequire(await realpath(anchor));
    let manifest: string | undefined;
    try { manifest = require.resolve(`${name}/package.json`); }
    catch {
      for (const root of require.resolve.paths(name) ?? []) {
        const candidate = join(root, name, "package.json");
        if (await stat(candidate).then(item => item.isFile(), () => false)) { manifest = candidate; break; }
      }
    }
    if (manifest === undefined) return null;
    const path = await realpath(manifest);
    if (!withinRoots(path, roots)) return null;
    const value = JSON.parse(await readFile(path, "utf8")) as { name?: unknown; version?: unknown };
    const entry = await realpath(require.resolve(name));
    if (value.name !== name || typeof value.version !== "string" || !withinRoots(entry, roots) || !(await stat(entry)).isFile()) return null;
    return { path, version: value.version };
  } catch { return null; }
}

async function resolveBundle(cliManifest: string, profileManifest: string, name: string, roots: readonly string[]) {
  // The verified official loader selects installAnchor first, then the profile.
  const selected = await resolvePackage(cliManifest, name, roots) ?? await resolvePackage(profileManifest, name, roots);
  if (selected === null) return null;
  try {
    const manifest = z.object({ dsh: z.object({ bundle: z.object({ patch: z.string().min(1) }) }) }).parse(await readJsonIfPresent(selected.path));
    const root = resolve(selected.path, "..");
    const path = await ownedRealpath(root, resolve(root, manifest.dsh.bundle.patch));
    const text = await readFile(path, "utf8");
    const document = parseDocument(text);
    if (document.errors.length > 0) return null;
    const patches: unknown = document.toJS({ maxAliasCount: 50 });
    if (!Array.isArray(patches)) return null;
    return { ...selected, patchPath: path, patchDigest: fingerprint(text), patches };
  } catch { return null; }
}

/** Resolve through actual importers, including peer dependencies; never scan a pnpm store for a coincidental copy. */
async function runtimePackages(cliManifest: string, profileManifest: string, roots: readonly string[]): Promise<{ versions: Record<string, string>; manifests: string[] }> {
  const base = await resolvePackage(cliManifest, "@deepseek-ai/dsh-base", roots);
  const hooks = await resolvePackage(cliManifest, "@deepseek-ai/dsh-hooks-claude-code", roots);
  const versions: Record<string, string> = {};
  const manifests: string[] = [];
  for (const [name, anchor] of [["@deepseek-ai/dsh-session", base?.path], ["@deepseek-ai/dsh-session-persistence", hooks?.path]] as const) {
    const found = await resolvePackage(profileManifest, name, roots) ?? await resolvePackage(cliManifest, name, roots) ?? (anchor === undefined ? null : await resolvePackage(anchor, name, roots));
    if (found !== null) { versions[name] = found.version; manifests.push(found.path); }
  }
  return { versions, manifests };
}

export async function discoverLauncherIntegrations(launcherDataRoot: string, codexInstances: readonly RegisteredInstance[] = [], probeCodex?: (instance: RegisteredInstance) => Promise<AdapterProbe>): Promise<DiscoveredIntegrations> {
  const targets: DiscoveredIntegration[] = [];
  const raw = await readJsonIfPresent(join(launcherDataRoot, "config.json"));
  if (raw !== undefined) {
    const parsed = catalogSchema.safeParse(raw);
    if (!parsed.success) throw new IntegrationError("LAUNCHER_CATALOG_INVALID", "Launcher 实例目录无法识别，请先在 Launcher 中检查实例。", 503);
    const catalog = parsed.data;
    unique(catalog.homes, "Home"); unique(catalog.versions, "版本"); unique(catalog.instances, "实例");
    const canonicalLauncherRoot = await realpath(launcherDataRoot);
    const host = await inspectLauncherCapabilities(canonicalLauncherRoot);
    for (const instance of catalog.instances) {
      const home = catalog.homes.find(item => item.id === instance.home_id);
      const version = catalog.versions.find(item => item.id === instance.version_id);
      if (home === undefined || version === undefined || !isAbsolute(home.path) || !isAbsolute(version.dir)) continue;
      const homeRoot = await realpath(home.path).catch(() => null);
      const versionRoot = await realpath(version.dir).catch(() => null);
      if (homeRoot === null || versionRoot === null) continue;
      const profilesRoot = join(homeRoot, "profiles");
      const entries = await readdir(profilesRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []; throw error;
      });
      for (const entry of entries) {
        if (!entry.isDirectory() || !safeSegment.test(entry.name)) continue;
        try {
        await ownedRealpath(homeRoot, profilesRoot);
        const profileRoot = await ownedRealpath(profilesRoot, join(profilesRoot, entry.name));
        const profile = await readJsonIfPresent(join(profileRoot, "package.json"));
        if (profile === undefined || typeof profile !== "object" || profile === null || !("dsh" in profile)) continue;
        const issues: string[] = [];
        if (host.issue !== null) issues.push(host.issue);
        const patchDigests: Array<string | null> = [];
        const patches: unknown[] = [];
        for (const root of [profileRoot, homeRoot]) {
          const text = await readFile(join(root, "cordis.patch.yml"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
          patchDigests.push(text === null ? null : fingerprint(text));
          if (text !== null) {
            try {
              const parsed = parseDocument(text);
              if (parsed.errors.length > 0) throw new Error("invalid patch");
              patches.push(parsed.toJS({ maxAliasCount: 50 }));
            } catch { issues.push("用户配置无法解析，请在 Launcher 中修复配置后重新检查接入。"); }
          }
        }
        issues.push(...inspectDshIntegrationOverrides(patches));
        const npmRoot = join(versionRoot, "node_modules", "@deepseek-ai", "dsh");
        const checkoutRoot = join(versionRoot, "apps", "cli");
        const cliRoot = await stat(join(checkoutRoot, "package.json")).then(() => checkoutRoot, () => npmRoot);
        const actualVersion = await packageVersion(join(cliRoot, "package.json"));
        if (actualVersion !== version.version) issues.push("实际安装版本与 Launcher 登记不一致，请先修复实例。");
        const cliPath = join(cliRoot, "lib", "bin.js");
        if (!(await stat(cliPath).then(item => item.isFile(), () => false))) issues.push("实例缺少官方启动程序。");
        const adapterId = SUPPORTED_DSH_INTEGRATIONS[version.version] ?? null;
        if (entry.name !== "web") issues.push("本批接入仅支持 web 配置。");
        if (adapterId === null) issues.push("此版本的完整启动与增量提交尚未验证。");
        if (Object.keys(instance.env_overrides ?? {}).some(key => ["DSH_HOME", "NODE_OPTIONS"].includes(key.toUpperCase()))) issues.push("实例包含会改变接入环境的覆盖项，请先在 Launcher 核对配置。");
        const packageRoots = [homeRoot, versionRoot];
        const { versions, manifests } = await runtimePackages(join(cliRoot, "package.json"), join(profileRoot, "package.json"), packageRoots);
        for (const name of ["dsh-session", "dsh-session-persistence"]) {
          const installed = versions[`@deepseek-ai/${name}`];
          if (installed !== version.version) issues.push(`${name} 未安装或与实例版本不一致。`);
        }
        const plugin = await resolveBundle(join(cliRoot, "package.json"), join(profileRoot, "package.json"), "dsh-session-maintenance", packageRoots);
        const pluginVersion = plugin?.version ?? null;
        const bundles = (profile as { dsh?: { profile?: { bundles?: unknown } } }).dsh?.profile?.bundles;
        const webApp = await resolveBundle(join(cliRoot, "package.json"), join(profileRoot, "package.json"), "@deepseek-ai/dsh-web-app", packageRoots);
        if (!Array.isArray(bundles) || !bundles.includes("@deepseek-ai/dsh-web-app") || webApp?.version !== version.version) issues.push("此配置没有启用匹配版本的 Web 应用，Launcher 不会按 Web 实例启动。");
        const pluginReady = compatiblePlugin(pluginVersion) && plugin !== null && maintenanceIntegrationBundleReady(plugin.patches) && Array.isArray(bundles) && bundles.includes("dsh-session-maintenance");
        const extraBundles = [];
        if (Array.isArray(bundles)) for (const name of bundles) {
          if (name === "dsh-session-maintenance" || name === "@deepseek-ai/dsh-web-app") continue;
          const bundle = typeof name === "string" ? await resolveBundle(join(cliRoot, "package.json"), join(profileRoot, "package.json"), name, packageRoots) : null;
          if (bundle === null) issues.push("此配置包含无法加载的插件组件，请在 Launcher 中修复后重新检查。");
          else {
            extraBundles.push(bundle);
            if (name !== "@deepseek-ai/dsh-base") issues.push(...inspectDshIntegrationOverrides([bundle.patches]));
          }
        }
        const id = integrationTargetId("dsh", canonicalLauncherRoot, instance.id, entry.name);
        const target: IntegrationTarget = {
          id, kind: "dsh", name: instance.name, version: version.version, profile: entry.name,
          status: issues.length > 0 ? "unsupported" : "available", adapterId,
          capabilities: [
            { id: "projection", label: "会话读取与增量提交", status: issues.length > 0 ? "unavailable" : "supported", detail: issues.length > 0 ? "实例尚未通过版本与组件检查。" : "已识别经过验证的版本组合；接入时再执行 Adapter 检查。" },
            { id: "plugin", label: "会话维护插件", status: pluginReady ? "supported" : "unavailable", detail: pluginReady ? `已安装 ${pluginVersion}` : "接入时由官方安装流程补齐。" },
            { id: "lifecycle", label: "随实例启动和收尾", status: "unchecked", detail: "完成实例绑定后启用。" },
          ], issues,
        };
        targets.push({ target, instanceId: instance.id, launcherDataRoot: canonicalLauncherRoot, homeRoot, versionRoot, profileRoot, cliPath, packageVersions: versions, pluginReady,
          fingerprint: fingerprint([canonicalLauncherRoot, host.digest, instance.id, home.id, version.id, homeRoot, versionRoot, profileRoot, actualVersion, versions, manifests, plugin, webApp, bundles, extraBundles, patchDigests, instance.env_overrides ?? {}]) });
        } catch {
          // A broken unrelated profile must not take down valid targets or scoped launches.
          const id = integrationTargetId("dsh", canonicalLauncherRoot, instance.id, entry.name);
          targets.push({ target: { id, kind: "dsh", name: `${instance.name} · ${entry.name}`, version: version.version, profile: entry.name,
            status: "unsupported", adapterId: null, capabilities: [], issues: ["此配置的数据或路径无法读取，请在 Launcher 中修复该配置。"] },
            instanceId: instance.id, fingerprint: fingerprint([id, "unreadable"]), launcherDataRoot: canonicalLauncherRoot, homeRoot, versionRoot,
            profileRoot: null, cliPath: null, packageVersions: {}, pluginReady: false });
        }
      }
    }
  }
  for (const instance of codexInstances.filter(item => item.platform === "codex")) {
    const homeRoot = await realpath(instance.root).catch(() => resolve(instance.root));
    const probe = probeCodex === undefined ? undefined : await probeCodex(instance);
    const readable = probe?.status === "compatible";
    const id = integrationTargetId("codex", homeRoot, instance.id, null);
    targets.push({ target: { id, kind: "codex", name: instance.displayName, version: `读取协议 ${instance.platformVersion}`, profile: null, status: readable ? "available" : "unsupported", adapterId: null,
      capabilities: [
        { id: "read", label: "读取已有会话", status: readable ? "supported" : "unavailable", detail: readable ? "已通过读取适配器的数据库和会话结构检查；首次导入在同步页操作。" : "该来源尚未通过实际读取适配器检查。" },
        { id: "native-write", label: "原生双向同步", status: "unavailable", detail: "完整原生对话写入尚未通过验证。" },
      ], issues: readable ? [] : ["Codex 读取版本或会话结构尚未通过验证，请检查来源。"] },
      instanceId: instance.id, launcherDataRoot: null, homeRoot, versionRoot: null, profileRoot: null, cliPath: null, packageVersions: {}, pluginReady: true,
      codexSource: { ...instance, root: homeRoot },
      fingerprint: fingerprint([instance.id, homeRoot, instance.platformVersion, readable]),
    });
  }
  return { launcherDetected: raw !== undefined, targets };
}
