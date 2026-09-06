import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse as parsePath, resolve } from "node:path";
import { z } from "zod";
import { parseDocument } from "yaml";
import type { DiscoveredIntegration } from "./launcher-discovery.js";
import { IntegrationError, readJsonIfPresent, writeJsonAtomically } from "./bindings.js";
import { windowsSystemTool } from "./windows-tools.js";

const hookSchema = z.strictObject({ schemaVersion: z.literal(1), program: z.string(), args: z.array(z.string()), timeoutMs: z.number().int().positive().max(300_000).optional() });
export type LauncherHook = z.infer<typeof hookSchema>;
export function launcherHooksEqual(left: unknown, right: unknown): boolean {
  const a = hookSchema.safeParse(left); const b = hookSchema.safeParse(right);
  return a.success && b.success && JSON.stringify(a.data) === JSON.stringify(b.data);
}
export interface PluginArtifact { readonly path: string; readonly sha256: string }
export interface IntegrationInstallOptions {
  readonly stateRoot: string;
  readonly engineEntry: string;
  readonly nodePath?: string;
  readonly artifact?: PluginArtifact;
  readonly run?: (program: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<void>;
}
export async function runOfficialCli(program: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }, timeoutMs = 240_000): Promise<void> {
  const taskkill = process.platform === "win32" ? windowsSystemTool("taskkill.exe") : undefined;
  await new Promise<void>((accept, reject) => {
    const child = spawn(program, args, { ...options, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "ignore"] });
    let timedOut = false;
    let termination: Promise<void> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      termination = (async () => {
        if (child.pid === undefined) return;
        if (process.platform === "win32") {
          // Only the process tree spawned by this request; never a name-based kill.
          await new Promise<void>((done) => {
            const killer = spawn(taskkill!, ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
            killer.once("error", () => { child.kill(); done(); });
            killer.once("close", () => { child.kill(); done(); });
          });
        } else {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      })();
    }, timeoutMs);
    child.once("error", () => { clearTimeout(timeout); reject(new IntegrationError("INTEGRATION_INSTALL_FAILED", "无法启动实例的官方插件安装程序。", 503)); });
    child.once("close", code => {
      clearTimeout(timeout);
      void (async () => {
        await termination;
        if (timedOut) reject(new IntegrationError("INTEGRATION_INSTALL_TIMEOUT", "插件安装超时，已停止安装进程，未启用接入。请修复接入后重试。", 504));
        else code === 0 ? accept() : reject(new IntegrationError("INTEGRATION_INSTALL_FAILED", "官方插件安装未完成，未启用接入。请检查实例后重试。", 503));
      })().catch(reject);
    });
  });
}

async function isMaintenanceEntry(entry: string, current: string): Promise<boolean> {
  if (!isAbsolute(entry) || !(await stat(entry).then(item => item.isFile(), () => false))) return false;
  if (resolve(entry) === resolve(current)) return true;
  if (basename(entry) === "dsh-session-maint.mjs" && basename(dirname(entry)) === "engine") {
    const build = await readJsonIfPresent(join(dirname(entry), "..", "BUILD-INFO.json"));
    return z.object({ schemaVersion: z.literal(1), protocolVersions: z.object({ externalLifecycle: z.literal(1) }), components: z.array(z.object({ name: z.string() })) })
      .safeParse(build).data?.components.some(item => item.name === "@linmu/dsh-session-maintenance-engine") === true;
  }
  if (basename(entry) === "main.js" && basename(dirname(entry)) === "dist") {
    return z.object({ name: z.literal("@linmu/dsh-session-maintenance-engine") }).safeParse(await readJsonIfPresent(join(dirname(entry), "..", "package.json"))).success;
  }
  return false;
}

async function isKnownWrapper(prefix: string[], program: string): Promise<boolean> {
  if (prefix.length === 0) return true;
  if (prefix.length !== 5 || !isAbsolute(prefix[0]!) || prefix[1] !== "--trace-file" || !isAbsolute(prefix[2]!) || prefix[3] !== "--" || resolve(prefix[4]!) !== resolve(program)) return false;
  // The released SM-13 trace wrapper only forwards stdin/stdout and writes lifecycle metadata.
  const bytes = await readFile(prefix[0]!).catch(() => null);
  return bytes !== null && createHash("sha256").update(bytes).digest("hex") === "604ec31f3011d62ae2c774b0d58f4aa85a2b6017d77bae022a8be27820a0b720";
}
export function launcherHookPath(target: DiscoveredIntegration): string {
  if (target.launcherDataRoot === null) throw new IntegrationError("INTEGRATION_KIND_INVALID", "此来源不使用 Launcher Hook。");
  return join(target.launcherDataRoot, "runtime-lifecycle.json");
}
export async function desiredLauncherHook(target: DiscoveredIntegration, options: IntegrationInstallOptions): Promise<LauncherHook> {
  if (!isAbsolute(options.engineEntry) || !(await stat(options.engineEntry).then(item => item.isFile(), () => false))) throw new IntegrationError("ENGINE_INSTALLATION_INCOMPLETE", "当前引擎缺少可重复启动的安装入口，请使用完整发行包。", 503);
  const program = options.nodePath ?? process.execPath;
  const raw = await readJsonIfPresent(launcherHookPath(target));
  if (raw === undefined) return { schemaVersion: 1, program, args: [options.engineEntry, "--state-root", options.stateRoot, "external-lifecycle", "--require-binding"], timeoutMs: 300_000 };
  const parsed = hookSchema.safeParse(raw);
  if (!parsed.success) throw new IntegrationError("LAUNCHER_HOOK_CONFLICT", "Launcher 已有无法识别的启动接入配置，未覆盖该配置。");
  const previous = parsed.data;
  const index = previous.args.indexOf("--state-root");
  const entry = index > 0 ? previous.args[index - 1] : undefined;
  if (resolve(previous.program) !== resolve(program) || index < 1 || previous.args[index + 1] === undefined ||
    resolve(previous.args[index + 1]!) !== resolve(options.stateRoot) || !previous.args.includes("external-lifecycle") ||
    entry === undefined || !(await isMaintenanceEntry(entry, options.engineEntry)) || !(await isKnownWrapper(previous.args.slice(0, index - 1), program)) ||
    ![JSON.stringify(["--state-root", previous.args[index + 1], "external-lifecycle"]), JSON.stringify(["--state-root", previous.args[index + 1], "external-lifecycle", "--require-binding"])].includes(JSON.stringify(previous.args.slice(index)))) {
    throw new IntegrationError("LAUNCHER_HOOK_CONFLICT", "Launcher 正由另一套启动接入配置管理，未覆盖它。请先处理现有接入。");
  }
  const args = [...previous.args]; args[index - 1] = options.engineEntry;
  if (!args.includes("--require-binding")) args.push("--require-binding");
  return { ...previous, args, timeoutMs: 300_000 };
}
async function profilePnpmStoreBase(profileRoot: string, fallback: string): Promise<string> {
  const recordPath = join(profileRoot, "node_modules", ".modules.yaml");
  const invalid = (reason: string) => new IntegrationError("INTEGRATION_STORE_RECORD_INVALID",
    `实例现有 pnpm 缓存记录（node_modules/.modules.yaml）${reason}，未执行插件安装。请先检查实例原有的包管理配置后重试。`);
  let info;
  try { info = await lstat(recordPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw invalid("无法读取");
  }
  // This is pnpm's generated local record, not a request to follow another
  // metadata file or inspect the cache's contents. JSON is valid YAML 1.2 too.
  const maxBytes = 4 * 1024 * 1024;
  if (!info.isFile() || info.size > maxBytes) throw invalid("不是有效的常规文件或超过大小限制");
  let bytes: Buffer;
  try { bytes = await readFile(recordPath); }
  catch { throw invalid("无法读取"); }
  if (bytes.length > maxBytes) throw invalid("超过大小限制");
  let recorded: unknown;
  try {
    const document = parseDocument(bytes.toString("utf8"), { uniqueKeys: true, prettyErrors: false });
    if (document.errors.length > 0 || document.warnings.length > 0) throw new Error("invalid YAML");
    recorded = document.toJS({ maxAliasCount: 0 });
  } catch { throw invalid("格式损坏或包含不支持的内容"); }
  const parsed = z.object({ storeDir: z.string().min(1) }).safeParse(recorded);
  if (!parsed.success) throw invalid("缺少有效的 storeDir 路径");
  const store = parsed.data.storeDir;
  if (store !== store.trim() || /[\u0000-\u001f\u007f]/u.test(store) || !isAbsolute(store) ||
      store.split(/[\\/]/u).some(segment => segment === "." || segment === "..") ||
      (process.platform === "win32" && parsePath(store).root.length <= 1)) {
    throw invalid("的 storeDir 必须是明确的本机绝对路径");
  }
  // .modules.yaml records the effective versioned directory, while the CLI's
  // --store-dir takes its base and appends its own vN suffix. Never pass v11 as
  // the base (which would select v11/v11), nor guess an unrecognized layout.
  const effectiveStore = resolve(store);
  if (!/^v[1-9]\d*$/u.test(basename(effectiveStore))) throw invalid("的 storeDir 版本目录格式无法识别");
  const base = dirname(effectiveStore);
  if (dirname(base) === base) throw invalid("的 storeDir 不能使用文件系统根目录作为缓存位置");
  return base;
}

export async function installIntegrationPlugin(target: DiscoveredIntegration, options: IntegrationInstallOptions): Promise<void> {
  if (target.pluginReady) return;
  if (target.cliPath === null || target.versionRoot === null || target.launcherDataRoot === null || target.profileRoot === null || target.target.profile === null) throw new IntegrationError("INTEGRATION_NOT_INSTALLABLE", "所选实例缺少安装信息。");
  const artifact = options.artifact ?? await readPackagedArtifact(options.engineEntry);
  if (artifact === undefined) throw new IntegrationError("INTEGRATION_PACKAGE_MISSING", "当前安装缺少配套插件包，请使用包含接入组件的完整 Maintenance 发行包。", 503);
  const bytes = await readFile(artifact.path);
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new IntegrationError("INTEGRATION_PACKAGE_CHANGED", "配套插件包校验失败，未执行安装。", 503);
  const storeBase = await profilePnpmStoreBase(target.profileRoot, join(target.launcherDataRoot, ".pnpm-store"));
  await (options.run ?? runOfficialCli)(options.nodePath ?? process.execPath, [target.cliPath, "plugin", "--profile", target.target.profile, "add", artifact.path,
    "--store-dir", storeBase, "--loglevel=info"], {
    cwd: target.versionRoot,
    env: { ...process.env, DSH_HOME: target.homeRoot, CI: "true", PATH: `${join(target.launcherDataRoot, "tools")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` },
  });
}
async function readPackagedArtifact(engineEntry: string): Promise<PluginArtifact | undefined> {
  const value = await readJsonIfPresent(join(dirname(engineEntry), "integration-package.json"));
  if (value === undefined) return undefined;
  const info = z.strictObject({ schemaVersion: z.literal(1), file: z.literal("dsh-session-maintenance.tgz"), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).parse(value);
  return { path: join(dirname(engineEntry), info.file), sha256: info.sha256 };
}
export async function configureLauncherHook(target: DiscoveredIntegration, options: IntegrationInstallOptions): Promise<void> {
  await writeJsonAtomically(launcherHookPath(target), await desiredLauncherHook(target, options));
}
