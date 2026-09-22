import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { INSTANCE_FOLDER_HINT } from '@linmu/dsh-session-contracts';
import { createWindowsFolderPicker } from './folder-picker.js';
import { IntegrationError } from './bindings.js';
import { SUPPORTED_DSH_INTEGRATIONS } from './launcher-discovery.js';
import { FOLDER_PICKER_READY } from './folder-script.js';

export type InstanceFolderPicker = (signal: AbortSignal) => Promise<string | null>;

export const INSTANCE_FOLDER_PICKER_TITLE = '选择 DSH 实例的数据目录（DSH Home）';
export { INSTANCE_FOLDER_HINT };

/** Same native chooser as the Vault binding; only the caption and the error code differ. */
export function createWindowsInstanceFolderPicker(options: { platform?: string; timeoutMs?: number; selectionTimeoutMs?: number; execute?: typeof import('node:child_process').execFile } = {}): InstanceFolderPicker {
  return createWindowsFolderPicker({
    ...options, title: INSTANCE_FOLDER_PICKER_TITLE, readyToken: FOLDER_PICKER_READY, errorCode: 'INSTANCE_FOLDER_INVALID',
  });
}

export interface InstanceHomeProfile {
  readonly profileId: string;
  readonly root: string;
  /** The profile enables the official Web bundle, so it can be attached as a Web instance. */
  readonly web: boolean;
}

/**
 * A directory under `profiles/` that is *not* a profile this engine can attach.
 *
 * `profiles/` is not a list of profiles: the DSH Home also keeps DSH-generated
 * directories there (`node_modules` above all, whose name is a perfectly legal
 * profile id), and an install may hold profiles that name no DSH program at all.
 * Such a directory must not decide the fate of the whole folder, but the operator
 * still deserves to know why it is missing from the list.
 */
export interface SkippedProfileEntry {
  /** The directory name, reported exactly as it appears under `profiles/`. */
  readonly entry: string;
  /** Why it was skipped; safe to show to the operator. */
  readonly reason: string;
}

export interface InstanceHomeInspection {
  /** Canonical DSH Home root, i.e. the folder the user selected. */
  readonly homeRoot: string;
  /** Folder name, offered as the instance identity; the caller still chooses the final id. */
  readonly suggestedInstanceId: string;
  readonly profiles: readonly InstanceHomeProfile[];
  /** Directories under `profiles/` that were recognized as profile folders but not attachable. */
  readonly skippedEntries: readonly SkippedProfileEntry[];
  /** Version actually installed in `versionRoot`, or the version the profile states when no install is reachable. */
  readonly runtimeVersion: string;
  /**
   * Root whose `node_modules/@deepseek-ai/dsh` the CLI was resolved from: the
   * `--prefix <versionRoot>` of the official install. `null` when the selected
   * folder only states a version and no installed program can be located.
   */
  readonly versionRoot: string | null;
  /** Absolute path of the installed CLI entry, so a caller can start this instance without Launcher. */
  readonly cliPath: string | null;
  /** Declared in the profile's manifest, when the manifest states it; compared with the installed version. */
  readonly declaredRuntimeVersion: string | null;
}

/** A folder choice: cancelled, or one inspection that still has to be confirmed. */
export type InstanceFolderSelection =
  | { readonly hint: string; readonly cancelled: true }
  | { readonly hint: string; readonly cancelled: false; readonly inspection: InstanceHomeInspection;
      /** Set by the Engine once it records the checked folder; confirming goes through this id. */
      readonly pendingId?: string };

/**
 * The whole "connect by folder" step: ask for a DSH Home, then describe what is
 * in it. Nothing is written here — the caller decides whether to register the
 * instance — so cancelling costs nothing and an unusable folder is reported
 * without leaving state behind.
 */
export async function selectInstanceFolder(pick: InstanceFolderPicker, signal: AbortSignal): Promise<InstanceFolderSelection> {
  const selected = await pick(signal);
  if (selected === null) return { hint: INSTANCE_FOLDER_HINT, cancelled: true };
  return { hint: INSTANCE_FOLDER_HINT, cancelled: false, inspection: await inspectInstanceFolder(selected) };
}

const profileIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const cliPackageName = '@deepseek-ai/dsh';

const invalid = (message: string) => new IntegrationError('INSTANCE_FOLDER_INVALID', message);

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(item => item.isDirectory(), () => false);
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(item => item.isFile(), () => false);
}

/** Bounded manifest read; a profile manifest is small, and anything larger is not one. */
async function readProfileManifest(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const buffer = await readFile(path);
    if (buffer.byteLength > 1_048_576) return undefined;
    const value: unknown = JSON.parse(buffer.toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function declaredDshVersion(manifest: Record<string, unknown>): string | null {
  for (const field of ['devDependencies', 'dependencies'] as const) {
    const section = manifest[field];
    if (typeof section !== 'object' || section === null || Array.isArray(section)) continue;
    const value = (section as Record<string, unknown>)[cliPackageName];
    if (typeof value !== 'string') continue;
    // `link:`/`file:` declarations carry a path; the installed manifest is authoritative for the version.
    if (value.startsWith('link:') || value.startsWith('file:')) continue;
    return value.trim() || null;
  }
  return null;
}

/** `link:` and `file:` values are paths, not ranges; anything else is a semver range we do not resolve here. */
function declaredDshPath(manifest: Record<string, unknown>, profileRoot: string): string | null {
  for (const field of ['devDependencies', 'dependencies'] as const) {
    const section = manifest[field];
    if (typeof section !== 'object' || section === null || Array.isArray(section)) continue;
    const value = (section as Record<string, unknown>)[cliPackageName];
    if (typeof value !== 'string') continue;
    for (const prefix of ['link:', 'file:'] as const) {
      if (!value.startsWith(prefix)) continue;
      const path = value.slice(prefix.length).trim();
      if (path !== '') return resolve(profileRoot, path);
    }
  }
  return null;
}

/**
 * The install anchor: the nearest ancestor whose `node_modules` holds this CLI,
 * which is exactly the `--prefix` of the official install and therefore the
 * working directory a launch of this instance must use. Derived only from where
 * the CLI actually resolves — never from a Launcher catalog. A package reached
 * through a store path (`.pnpm/...`) has no such ancestor and is rejected.
 */
function installAnchor(cliManifest: string): string | null {
  const packageRoot = dirname(cliManifest);
  let current = dirname(dirname(packageRoot));
  for (;;) {
    if (resolve(join(current, 'node_modules', cliPackageName)) === resolve(packageRoot)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function readCliVersion(versionRoot: string): Promise<string | null> {
  const manifest = await readProfileManifest(join(versionRoot, 'node_modules', cliPackageName, 'package.json'));
  const name = manifest?.['name'], version = manifest?.['version'];
  return name === cliPackageName && typeof version === 'string' && version !== '' ? version : null;
}

/**
 * The program a profile provably names, read straight from its own manifest.
 *
 * This deliberately does not walk upwards for `node_modules`: that walk is shared by every
 * profile through the Home's own `profiles/node_modules`, so it cannot tell profiles apart. On
 * this machine it is actively misleading — the shared link and `web`'s own link resolve to
 * *different* roots for the same program, which read as "two profiles disagree about the
 * program" when only one profile named a program at all.
 */
async function declaredProfileProgram(manifest: Record<string, unknown>, profileRoot: string): Promise<{ readonly runtimeVersion: string | null; readonly versionRoot: string | null; readonly cliPath: string | null } | null> {
  const stated = declaredDshVersion(manifest);
  if (stated !== null) return { runtimeVersion: stated, versionRoot: null, cliPath: null };
  const declared = declaredDshPath(manifest, profileRoot);
  if (declared === null) return null;
  const cliManifest = join(declared, 'package.json');
  if (!(await isFile(cliManifest))) return null;
  const anchor = installAnchor(cliManifest);
  if (anchor === null) return null;
  // The stored root must be canonical: it is handed to the instance launch and to the adapter.
  const versionRoot = await realpath(anchor).catch(() => null);
  if (versionRoot === null) return null;
  const installed = await readCliVersion(versionRoot);
  return { runtimeVersion: installed, versionRoot, cliPath: join(versionRoot, 'node_modules', cliPackageName, 'lib', 'bin.js') };
}

interface ProfileInspection {
  readonly profile: InstanceHomeProfile;
  /**
   * The program folder this profile resolves to, when it can be located from the
   * folder alone. `null` means the profile only *states* a version; attaching
   * such an instance still needs the program to be installed.
   */
  readonly versionRoot: string | null;
  readonly cliPath: string | null;
  /** Version actually installed in the resolved program folder, or the version this profile states. */
  readonly runtimeVersion: string;
  /** Stated in the profile manifest, when it states a version rather than a path. */
  readonly declaredRuntimeVersion: string | null;
}

async function inspectProfile(homeRoot: string, entry: string): Promise<ProfileInspection | SkippedProfileEntry> {
  const profileRoot = join(homeRoot, 'profiles', entry);
  // `profiles/` also holds DSH-generated directories. `node_modules` is a legal profile id, so
  // the name alone proves nothing: only a readable manifest that declares `dsh.profile.bundles`
  // makes a directory a profile at all. One that does not is skipped instead of failing the
  // whole selection, because the operator also selected the Home for its real profiles.
  const notAProfile = (reason: string): SkippedProfileEntry => ({ entry, reason });
  const manifest = await readProfileManifest(join(profileRoot, 'package.json'));
  if (manifest === undefined) return notAProfile('缺少可读取的 profile 清单（package.json），不是 DSH 配置目录。');
  const dsh = manifest['dsh'];
  const bundles = typeof dsh === 'object' && dsh !== null && !Array.isArray(dsh)
    ? (dsh as { profile?: { bundles?: unknown } }).profile?.bundles : undefined;
  if (!Array.isArray(bundles)) return notAProfile('清单未声明 dsh.profile.bundles，不是 DSH 配置目录。');
  // A profile is only attachable when it names the program that runs it. This machine shows why
  // the alternative (trust the nearest `node_modules` above it) cannot work: the Home's shared
  // `profiles/node_modules` link answers for every profile, and the anchor it yields differs from
  // the one a profile's own `link:` declaration yields, so two profiles that use the *same*
  // program looked like a conflict — while a profile that declares nothing looked usable.
  const declared = await declaredProfileProgram(manifest, profileRoot);
  if (declared === null)
    return notAProfile(`清单未声明 ${cliPackageName}（路径或版本），无法确定这个配置要用哪个 DSH 程序。`);
  const unsupported = (version: string) => invalid(`此实例的 DSH 版本 ${version} 尚未验证接入，请改用受支持的版本。`);
  // A declared version is only checkable against the install it names; a declared path is
  // resolved from this folder alone.
  if (declared.versionRoot === null) {
    if (!(declared.runtimeVersion! in SUPPORTED_DSH_INTEGRATIONS)) throw unsupported(declared.runtimeVersion!);
    return { profile: { profileId: entry, root: profileRoot, web: bundles.includes('@deepseek-ai/dsh-web-app') },
      runtimeVersion: declared.runtimeVersion!, versionRoot: null, cliPath: null, declaredRuntimeVersion: declared.runtimeVersion! };
  }
  if (declared.runtimeVersion === null)
    throw invalid(`配置 ${entry} 声明的 DSH 程序目录无法读取，请先用官方 CLI 修复这个实例。`);
  if (!(await isFile(declared.cliPath!))) throw invalid('此 DSH Home 的程序目录缺少官方启动程序，请重新安装这个实例。');
  if (!(declared.runtimeVersion in SUPPORTED_DSH_INTEGRATIONS)) throw unsupported(declared.runtimeVersion);
  return { profile: { profileId: entry, root: profileRoot, web: bundles.includes('@deepseek-ai/dsh-web-app') },
    runtimeVersion: declared.runtimeVersion, versionRoot: declared.versionRoot, cliPath: declared.cliPath,
    declaredRuntimeVersion: null };
}

/**
 * Check a user-selected folder as a DSH Home: what an instance connection needs
 * before it can read sessions. Nothing here reads a Launcher catalog, so the
 * folder alone is enough to describe the instance.
 */
export async function inspectInstanceFolder(selected: string): Promise<InstanceHomeInspection> {
  if (typeof selected !== 'string' || !isAbsolute(selected)) throw invalid('请选择 DSH Home 的完整文件夹路径');
  const homeRoot = await realpath(selected).catch(() => { throw invalid('所选文件夹不存在或无法访问'); });
  if (!(await isDirectory(homeRoot))) throw invalid('所选路径不是文件夹');
  const profilesRoot = join(homeRoot, 'profiles');
  if (!(await isDirectory(profilesRoot))) throw invalid('所选文件夹不是 DSH Home：缺少 profiles 文件夹');
  const entries = await readdir(profilesRoot, { withFileTypes: true }).catch(() => { throw invalid('无法读取所选文件夹的 profiles 目录'); });
  const names = entries.filter(entry => entry.isDirectory() && profileIdPattern.test(entry.name)).map(entry => entry.name).sort();
  const inspected: ProfileInspection[] = [];
  const skippedEntries: SkippedProfileEntry[] = [];
  for (const name of names) {
    const result = await inspectProfile(homeRoot, name);
    if ('profile' in result) inspected.push(result);
    else skippedEntries.push(result);
  }
  if (inspected.length === 0) {
    // Every directory was skipped, so there is no instance here to attach. Say which ones and
    // why, because "no profile" on its own would hide the DSH-generated directories.
    if (names.length === 0) throw invalid('所选 DSH Home 尚未安装任何 DSH 配置，请先用官方 CLI 启动一次。');
    throw invalid(`所选 DSH Home 没有可接入的 DSH 配置：${skippedEntries.map(item => `${item.entry}（${item.reason}）`).join('；')}`);
  }
  // One selected folder describes one instance, so every profile in it must agree
  // on the program that reads its sessions. Only attachable profiles take part:
  // a skipped directory has no program to agree or disagree with.
  const programs = [...new Set(inspected.map(item => `${item.runtimeVersion}\u0000${item.versionRoot === null ? '' : resolve(item.versionRoot)}`))];
  if (programs.length !== 1) throw invalid('所选 DSH Home 的多个配置使用不同的 DSH 程序目录，无法确定接入哪个实例。');
  const first = inspected[0]!;
  const suggested = basename(homeRoot);
  return {
    homeRoot,
    suggestedInstanceId: profileIdPattern.test(suggested) ? suggested : 'dsh-instance',
    profiles: inspected.map(item => item.profile),
    skippedEntries,
    runtimeVersion: first.runtimeVersion,
    versionRoot: first.versionRoot,
    cliPath: first.cliPath,
    declaredRuntimeVersion: first.declaredRuntimeVersion,
  };
}
