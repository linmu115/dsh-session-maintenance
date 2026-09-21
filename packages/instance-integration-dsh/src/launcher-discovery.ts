import { checkDshPluginDeclaration } from './plugin-compatibility.js';
import type { HostPluginIssue } from '@linmu/dsh-session-contracts';
import { supportsPluginVersion } from "@linmu/dsh-session-extension-gpt-compat";
import { verifyDsh015RuntimeAttestation } from "./runtime-attestation.js";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { parseDocument } from "yaml";
import { maintenanceIntegrationBundleReady } from "@linmu/dsh-adapter-dsh";
import { inspectRc2ProfileOverrides } from "./rc2-profile-overrides.js";
import type { AdapterProbe, DshIntegrationConnectionKind, IntegrationTarget, RegisteredInstance, StandaloneInstance } from "@linmu/dsh-session-contracts";
import { IntegrationError, readJsonIfPresent } from "./bindings.js";
import { inspectLauncherCapabilities } from "./launcher-capabilities.js";

const catalogSchema = z.object({
  homes: z.array(z.object({ id: z.string(), name: z.string(), path: z.string() })),
  versions: z.array(z.object({ id: z.string(), version: z.string(), dir: z.string() })),
  instances: z.array(z.object({ id: z.string(), name: z.string(), home_id: z.string(), version_id: z.string(), env_overrides: z.record(z.string(), z.string()).optional() })),
});
export const SUPPORTED_DSH_INTEGRATIONS: Readonly<Record<string, string>> = {
  "0.1.2-alpha.2": "dsh-alpha2", "0.1.2-rc.1": "dsh-rc1", "0.1.5-rc.2": "dsh-0.1.5",
};
export type { DiscoveredIntegration, DiscoveredIntegrations } from "@linmu/dsh-session-contracts";
import type { DiscoveredIntegration, DiscoveredIntegrations } from "@linmu/dsh-session-contracts";
const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export function integrationTargetId(kind: string, scope: string, instanceId: string, profileId: string | null): string {
  return `${kind}-${createHash("sha256").update(JSON.stringify([scope, instanceId, profileId])).digest("hex").slice(0, 32)}`;
}
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

/**
 * The startup gate: instance identity plus the actual integration contract.
 *
 * These inputs answer "is this still the same instance, and does the peer that
 * reads its sessions still speak the same contract?". A change here means the
 * binding genuinely cannot be trusted and a re-check is required:
 *
 * - identity: launcher root, instance/home/version ids and roots, the profile.
 * - host and runtime contract: Launcher capability digest, the RC2 attestation
 *   receipt digest (which already pins the resolved runtime closure by hash),
 *   the actually installed runtime version, and the environment overrides that
 *   change how the adapter reads the instance.
 * - effective user patch layers (profile and home `cordis.patch.yml`): a user
 *   patch can disable the persistence or session services the adapter relies
 *   on, so the composed layer is contract, not inventory.
 * - the Maintenance integration plugin's own resolved manifest and bundle patch:
 *   it is the peer of this contract, not an ordinary business plugin.
 *
 * Ordinary plugin composition is intentionally excluded; see
 * {@link pluginInventoryFingerprint}.
 */
function contractFingerprint(input: {
  canonicalLauncherRoot: string; hostDigest: string | null; attestationDigest: string | null;
  instanceId: string; homeId: string; versionId: string;
  homeRoot: string; versionRoot: string | null; profileRoot: string | null;
  actualVersion: string | null; envOverrides: Readonly<Record<string, string>>;
  plugin: unknown; patchDigests: readonly (string | null)[];
}): string {
  return fingerprint([
    input.canonicalLauncherRoot, input.hostDigest, input.attestationDigest,
    input.instanceId, input.homeId, input.versionId,
    input.homeRoot, input.versionRoot, input.profileRoot,
    input.actualVersion, input.envOverrides,
    input.plugin, input.patchDigests,
  ]);
}

/**
 * Diagnostic record of the ordinary business plugin composition. Never gates a
 * launch.
 *
 * Kept so that installing, removing or upgrading a business plugin can be shown
 * and explained without becoming a startup precondition, which is precisely the
 * MNT-001 defect. Real incompatibilities still gate through their own explicit
 * checks (`pluginReady`, the declared host/adapter/format declarations and the
 * per-package version checks), not through a byte difference in this inventory.
 */
function pluginInventoryFingerprint(input: {
  versions: Readonly<Record<string, string>>; manifests: readonly string[];
  webApp: unknown; bundles: unknown; extraBundles: unknown;
}): string {
  return fingerprint([
    input.versions, input.manifests,
    input.webApp, input.bundles, input.extraBundles,
  ]);
}

function unique<T extends { id: string }>(items: T[], label: string): void {
  if (new Set(items.map(item => item.id)).size !== items.length) throw new IntegrationError("LAUNCHER_CATALOG_INVALID", `${label}存在重复标识，无法确定接入对象。`, 503);
}

/**
 * Fallback for records written before the binding carried a connection source.
 *
 * A Launcher target always has a Launcher data root; a target without one came
 * from the standalone synthesis path, which is the underlying mechanism a
 * directory connection uses. This is exactly how such a record was treated
 * before, so existing bindings keep their behaviour without being migrated.
 */
export function classifyIntegrationConnectionKind(launcherDataRoot: string | null): DshIntegrationConnectionKind {
  return launcherDataRoot === null ? "directory" : "launcher";
}

/** A stored binding without an explicit source stays `legacy`; existing records are never rewritten. */
export function resolveBindingConnectionKind(binding: { readonly connectionKind?: DshIntegrationConnectionKind | undefined; readonly launcherDataRoot: string | null }): DshIntegrationConnectionKind {
  return binding.connectionKind ?? "legacy";
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

function withinRoots(path: string, roots: readonly string[]): boolean {
  return roots.some(root => { const part = relative(root, path); return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); });
}
async function resolvePackageManifest(anchor: string, name: string, roots: readonly string[]): Promise<{ path: string; version: string } | null> {
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
    if (value.name !== name || typeof value.version !== "string") return null;
    return { path, version: value.version };
  } catch { return null; }
}

async function resolvePackage(anchor: string, name: string, roots: readonly string[]) {
  const manifest = await resolvePackageManifest(anchor, name, roots);
  if (manifest === null) return null;
  try {
    const require = createRequire(await realpath(anchor));
    const entry = await realpath(require.resolve(name));
    return withinRoots(entry, roots) && (await stat(entry)).isFile() ? manifest : null;
  } catch { return null; }
}

async function resolveBundle(cliManifest: string, profileManifest: string, name: string, roots: readonly string[]) {
  // The verified official loader selects installAnchor first, then the profile.
  // A bundle is a manifest and patch layer; pure composition bundles need no JS entry.
  const selected = await resolvePackageManifest(cliManifest, name, roots) ?? await resolvePackageManifest(profileManifest, name, roots);
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

/** Shared by the installed verifier and registration; no Launcher state required. */
export async function inspectDshIntegrationPlugin(input: { cliManifest: string; profileManifest: string; roots: readonly string[]; hostVersion: string }) {
  const { cliManifest, profileManifest, roots, hostVersion } = input;
  const selected = await resolvePackageManifest(cliManifest, 'dsh-session-maintenance', roots) ?? await resolvePackageManifest(profileManifest, 'dsh-session-maintenance', roots);
  const fail = (code: string, message: string) => ({ ready: false, issue: { code, message } as HostPluginIssue, plugin: selected });
  if (!selected) return fail('INSTANCE_PLUGIN_MISSING', '未找到实例接入插件，请通过 DSH 官方插件命令安装。');
  const metadata = await readJsonIfPresent(selected.path) as { version: string; dshMaintenanceIntegration?: unknown };
  const compatibility = checkDshPluginDeclaration(metadata, hostVersion);
  if (compatibility) return fail(compatibility.code, compatibility.message);
  const profile = await readJsonIfPresent(profileManifest) as { dsh?: { profile?: { bundles?: unknown } } };
  const bundles = profile?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || !bundles.includes('dsh-session-maintenance')) return fail('INSTANCE_PLUGIN_DISABLED', `已安装接入插件 ${selected.version}，但当前 profile 未启用其 bundle。`);
  const plugin = await resolveBundle(cliManifest, profileManifest, 'dsh-session-maintenance', roots);
  if (!plugin || !maintenanceIntegrationBundleReady(plugin.patches)) return fail('INSTANCE_PLUGIN_BUNDLE_INVALID', '接入插件 bundle 无法加载或缺少必要接入配置，请重新安装完整发行包。');
  const runtime = await resolvePackage(cliManifest, 'dsh-session-maintenance', roots) ?? await resolvePackage(profileManifest, 'dsh-session-maintenance', roots);
  if (runtime?.path !== plugin.path) return fail('INSTANCE_PLUGIN_RESOLUTION_MISMATCH', '接入插件运行入口与 bundle 解析位置不一致，或运行入口不存在。');
  return { ready: true, issue: undefined, plugin };
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
  const jsonl=await resolvePackage(cliManifest,"@deepseek-ai/dsh-session-persistence-jsonl",roots)??await resolvePackage(profileManifest,"@deepseek-ai/dsh-session-persistence-jsonl",roots)??(base===null?null:await resolvePackage(base.path,"@deepseek-ai/dsh-session-persistence-jsonl",roots));
  if(jsonl){versions["@deepseek-ai/dsh-session-persistence-jsonl"]=jsonl.version;manifests.push(jsonl.path);const catalog=await resolvePackage(jsonl.path,"@deepseek-ai/dsh-session-format-catalog",roots);if(catalog){versions["@deepseek-ai/dsh-session-format-catalog"]=catalog.version;manifests.push(catalog.path);}}
  return { versions, manifests };
}

export async function inspectStandaloneInstance(config: StandaloneInstance): Promise<DiscoveredIntegration> {
  if (!isAbsolute(config.homeRoot) || !isAbsolute(config.versionRoot)) throw new IntegrationError('INSTANCE_PATH_INVALID', '实例 Home 和程序目录必须是绝对路径。');
  const discovery = await discoverLauncherIntegrations(config.homeRoot, [], undefined, config);
  const target = discovery.targets.find(item => item.target.profile === config.profileId);
  if (!target) throw new IntegrationError('INSTANCE_PROFILE_MISSING', '未找到已安装的 DSH 配置，请先按教程安装宿主和接入插件。');
  return target;
}

export async function discoverLauncherIntegrations(launcherDataRoot: string, codexInstances: readonly RegisteredInstance[] = [], probeCodex?: (instance: RegisteredInstance) => Promise<AdapterProbe>, standalone?: StandaloneInstance): Promise<DiscoveredIntegrations> {
  const targets: DiscoveredIntegration[] = [];
  const raw = standalone ? { homes: [{ id: 'home', name: standalone.name, path: standalone.homeRoot }],
    versions: [{ id: 'runtime', version: standalone.runtimeVersion, dir: standalone.versionRoot }],
    instances: [{ id: standalone.instanceId, name: standalone.name, home_id: 'home', version_id: 'runtime' }] }
    : await readJsonIfPresent(join(launcherDataRoot, "config.json"));
  if (raw !== undefined) {
    const parsed = catalogSchema.safeParse(raw);
    if (!parsed.success) throw new IntegrationError("LAUNCHER_CATALOG_INVALID", "Launcher 实例目录无法识别，请先在 Launcher 中检查实例。", 503);
    const catalog = parsed.data;
    unique(catalog.homes, "Home"); unique(catalog.versions, "版本"); unique(catalog.instances, "实例");
    const canonicalLauncherRoot = await realpath(launcherDataRoot);
    const host = standalone ? { digest: null, issue: null } : await inspectLauncherCapabilities(canonicalLauncherRoot);
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
        if (!entry.isDirectory() || !safeSegment.test(entry.name) || (standalone && entry.name !== standalone.profileId)) continue;
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
        const overrideScope = { runtimeVersion: version.version, instanceId: instance.id, profileId: entry.name };
        issues.push(...inspectRc2ProfileOverrides(patches, overrideScope));
        const npmRoot = join(versionRoot, "node_modules", "@deepseek-ai", "dsh");
        const checkoutRoot = join(versionRoot, "apps", "cli");
        const cliRoot = await stat(join(checkoutRoot, "package.json")).then(() => checkoutRoot, () => npmRoot);
        const actualVersion = await packageVersion(join(cliRoot, "package.json"));
        if (actualVersion !== version.version) issues.push("实际安装版本与 Launcher 登记不一致，请先修复实例。");
        const cliPath = join(cliRoot, "lib", "bin.js");
        if (!(await stat(cliPath).then(item => item.isFile(), () => false))) issues.push("实例缺少官方启动程序。");
        let adapterId = SUPPORTED_DSH_INTEGRATIONS[version.version] ?? null;
        if (entry.name !== "web") issues.push("本批接入仅支持 web 配置。");
        if (adapterId === null) issues.push("此版本的完整启动与增量提交尚未验证。");
        if (Object.keys(instance.env_overrides ?? {}).some(key => ["DSH_HOME", "NODE_OPTIONS"].includes(key.toUpperCase()))) issues.push("实例包含会改变接入环境的覆盖项，请先在 Launcher 核对配置。");
        const packageRoots = [homeRoot, versionRoot];
        const { versions, manifests } = await runtimePackages(join(cliRoot, "package.json"), join(profileRoot, "package.json"), packageRoots);
        for (const name of ["dsh-session", "dsh-session-persistence"]) {
          const installed = versions[`@deepseek-ai/${name}`];
          if (installed !== version.version) issues.push(`${name} 未安装或与实例版本不一致。`);
        }
        const pluginCheck = await inspectDshIntegrationPlugin({ cliManifest: join(cliRoot, "package.json"), profileManifest: join(profileRoot, "package.json"), roots: packageRoots, hostVersion: version.version });
        const plugin = pluginCheck.plugin;
        const pluginVersion = plugin?.version ?? null;
        const bundles = (profile as { dsh?: { profile?: { bundles?: unknown } } }).dsh?.profile?.bundles;
        const webApp = await resolveBundle(join(cliRoot, "package.json"), join(profileRoot, "package.json"), "@deepseek-ai/dsh-web-app", packageRoots);
        if (!Array.isArray(bundles) || !bundles.includes("@deepseek-ai/dsh-web-app") || webApp?.version !== version.version) issues.push("此配置没有启用匹配版本的 Web 应用，无法按 Web 实例启动。");
        const pluginReady = pluginCheck.ready;
        const extraBundles = [];
        if (Array.isArray(bundles)) for (const name of bundles) {
          if (name === "dsh-session-maintenance" || name === "@deepseek-ai/dsh-web-app") continue;
          const bundle = typeof name === "string" ? await resolveBundle(join(cliRoot, "package.json"), join(profileRoot, "package.json"), name, packageRoots) : null;
          if (bundle === null) issues.push("此配置包含无法加载的插件组件，请在 Launcher 中修复后重新检查。");
          else {
            extraBundles.push(bundle);
            if (name !== "@deepseek-ai/dsh-base") issues.push(...inspectRc2ProfileOverrides([bundle.patches], overrideScope));
          }
        }
        if(version.version === "0.1.5-rc.2" && Array.isArray(bundles) && bundles.includes("dsh-gpt-compat")) {
          const formatPlugin=await resolvePackage(join(profileRoot,"package.json"),"dsh-gpt-compat",packageRoots);
          if(!formatPlugin || !supportsPluginVersion(formatPlugin.version)) issues.push("GPT 扩展数据 Adapter 尚未验证此插件版本。");
          else { versions["dsh-gpt-compat"]=formatPlugin.version; manifests.push(formatPlugin.path); }
        }
        let runtimeCapabilities:readonly string[]=["sessionPersistence","session/event","session/flush"];
        let attestationDigest:string|null=null;
        let coreBinding:{path:string;sha256:string}|undefined;
        if(version.version === "0.1.5-rc.2") {
          if(versions["@deepseek-ai/dsh-session-persistence-jsonl"]!==version.version)issues.push("实际 JSONL backend 未解析到 RC2。 ");
          if(versions["@deepseek-ai/dsh-session-format-catalog"]!==version.version)issues.push("实际 format catalog 未解析到 RC2。");
          try {const attested=await verifyDsh015RuntimeAttestation({profileRoot,instanceId:instance.id,profileId:entry.name,homeRoot,cliPath,launcherDigest:host.digest,resolvedManifests:manifests,expectedAdapterId:adapterId??"dsh-0.1.5"});runtimeCapabilities=attested.runtimeCapabilities;attestationDigest=attested.digest;coreBinding=attested.coreBinding;}catch(error){issues.push(error instanceof Error?error.message:"RC2 能力验证失败。");runtimeCapabilities=[];}
        }
        const id = integrationTargetId("dsh", canonicalLauncherRoot, instance.id, entry.name);
        const target: IntegrationTarget = {
          id, kind: "dsh", name: instance.name, version: version.version, profile: entry.name,
          status: issues.length > 0 ? "unsupported" : "available", adapterId,
          capabilities: [
            { id: "projection", label: "会话读取与增量提交", status: issues.length > 0 ? "unavailable" : "supported", detail: issues.length > 0 ? "实例尚未通过版本与组件检查。" : "已识别经过验证的版本组合；接入时再执行 Adapter 检查。" },
            { id: "plugin", label: "会话维护插件", status: pluginReady ? "supported" : "unavailable", detail: pluginReady ? `已安装 ${pluginVersion}` : pluginCheck.issue!.message },
            { id: "lifecycle", label: "随实例启动和收尾", status: "unchecked", detail: "完成实例绑定后启用。" },
          ], issues,
        };
        targets.push({ target, instanceId: instance.id, launcherDataRoot: standalone ? null : canonicalLauncherRoot, connectionKind: classifyIntegrationConnectionKind(standalone ? null : canonicalLauncherRoot), homeRoot, versionRoot, profileRoot, cliPath, packageVersions: versions, pluginReady, ...(pluginCheck.issue ? { pluginIssue: pluginCheck.issue } : {}), runtimeCapabilities, ...(coreBinding?{coreBinding}:{}),
          // Startup gate: identity, the runtime/format contract, the effective user
          // patch layers and the integration plugin itself. See the contract's own
          // doc comment. Ordinary business plugin composition is recorded separately
          // below and must never gate a launch by itself.
          fingerprint: contractFingerprint({
            canonicalLauncherRoot, hostDigest: host.digest,
            attestationDigest: attestationDigest ?? "",
            instanceId: instance.id, homeId: home.id, versionId: version.id,
            homeRoot, versionRoot, profileRoot, actualVersion,
            envOverrides: instance.env_overrides ?? {},
            plugin, patchDigests,
          }),
          pluginInventory: pluginInventoryFingerprint({ versions, manifests, webApp, bundles, extraBundles }) });
        } catch {
          // A broken unrelated profile must not take down valid targets or scoped launches.
          const id = integrationTargetId("dsh", canonicalLauncherRoot, instance.id, entry.name);
          targets.push({ target: { id, kind: "dsh", name: `${instance.name} · ${entry.name}`, version: version.version, profile: entry.name,
            status: "unsupported", adapterId: null, capabilities: [], issues: ["此配置的数据或路径无法读取，请在 Launcher 中修复该配置。"] },
            instanceId: instance.id, fingerprint: fingerprint([id, "unreadable"]), launcherDataRoot: standalone ? null : canonicalLauncherRoot, connectionKind: classifyIntegrationConnectionKind(standalone ? null : canonicalLauncherRoot), homeRoot, versionRoot,
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
      instanceId: instance.id, launcherDataRoot: null, connectionKind: classifyIntegrationConnectionKind(null), homeRoot, versionRoot: null, profileRoot: null, cliPath: null, packageVersions: {}, pluginReady: true,
      codexSource: { ...instance, root: homeRoot },
      fingerprint: fingerprint([instance.id, homeRoot, instance.platformVersion, readable]),
    });
  }
  return { launcherDetected: !standalone && raw !== undefined, targets };
}
