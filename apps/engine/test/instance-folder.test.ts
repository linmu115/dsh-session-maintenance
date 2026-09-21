import { afterEach, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import type { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWindowsInstanceFolderPicker, inspectInstanceFolder } from '../src/instance-folder.js';
import { FOLDER_PICKER_READY } from '../src/vault-folder-script.js';

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const runtimeVersion = '0.1.2-rc.1';
const cliPackage = '@deepseek-ai/dsh';

function pickerHelper() {
  const stderr = new PassThrough();
  let finish: (error: Error | null, stdout: string) => void;
  let signal: AbortSignal;
  const launch = vi.fn((_file, _args, options, callback) => {
    finish = callback;
    signal = options.signal;
    signal.addEventListener('abort', () => callback(new Error('aborted'), ''), { once: true });
    return { stderr };
  });
  return {
    launch,
    picker: createWindowsInstanceFolderPicker({ platform: 'win32', execute: launch as unknown as typeof execFile }),
    finish: (output: string, error: Error | null = null) => finish(error, output),
    ready: () => stderr.write(`${FOLDER_PICKER_READY}\r\n`),
    aborted: () => signal.aborted,
    /** The helper is one program; the caption is the only per-entry difference. */
    script: () => Buffer.from(launch.mock.calls[0]![1][5]!, 'base64').toString('utf16le'),
  };
}

async function json(path: string, value: unknown) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

interface SyntheticHome {
  readonly root: string;
  readonly homeRoot: string;
  readonly versionRoot: string;
  readonly profileRoot: string;
}

/**
 * A synthetic DSH Home laid out as the official install does: the data folder
 * (`DSH_HOME`) is a sibling of the program folder, exactly like
 * `npm install --prefix <root>/runtime @deepseek-ai/dsh` started with
 * `DSH_HOME=<root>/my-dsh-home`.
 */
async function syntheticHome(options: { cli?: boolean; cliEntry?: boolean; homeName?: string; declareRuntime?: boolean } = {}): Promise<SyntheticHome> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-instance-folder-'));
  roots.push(root);
  // The check canonicalizes what it stores, so build expectations from the canonical root too.
  const canonical = await realpath(root);
  const homeRoot = join(canonical, options.homeName ?? 'my-dsh-home');
  const versionRoot = join(canonical, 'runtime');
  const profileRoot = join(homeRoot, 'profiles', 'web');
  await mkdir(join(homeRoot, 'sessions', 'project-fixture'), { recursive: true });
  await mkdir(profileRoot, { recursive: true });
  if (options.cli !== false) {
    await json(join(versionRoot, 'package.json'), { name: 'local-runtime', private: true });
    await json(join(versionRoot, 'node_modules', cliPackage, 'package.json'), { name: cliPackage, version: runtimeVersion });
    if (options.cliEntry !== false) {
      await mkdir(join(versionRoot, 'node_modules', cliPackage, 'lib'), { recursive: true });
      await writeFile(join(versionRoot, 'node_modules', cliPackage, 'lib', 'bin.js'), '// synthetic CLI');
    }
  }
  await writeProfileManifest({ root, homeRoot, versionRoot, profileRoot }, {
    declareRuntime: options.declareRuntime !== false, statedVersion: null, bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  });
  return { root, homeRoot, versionRoot, profileRoot };
}

/** Writes the profile manifest the way an installed profile states it: bundles, plus the program path or a version. */
async function writeProfileManifest(home: SyntheticHome, options: { declareRuntime: boolean; statedVersion: string | null; bundles: readonly string[] }): Promise<void> {
  const manifest: Record<string, unknown> = { name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: [...options.bundles] } } };
  // `link:` is what a launcher-installed profile states; a version is what a profile that pins the host states.
  if (options.declareRuntime) manifest.devDependencies = { [cliPackage]: options.statedVersion ?? `link:${join(home.versionRoot, 'node_modules', cliPackage)}` };
  await json(join(home.profileRoot, 'package.json'), manifest);
}

it('bounds helper startup and aborts it when the shell never becomes ready', async () => {
  vi.useFakeTimers();
  const h = pickerHelper();
  const result = expect(h.picker(new AbortController().signal)).rejects.toThrow('未能及时打开');
  await vi.advanceTimersByTimeAsync(20_000);
  await result;
  expect(h.aborted()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('allows time to choose after readiness and returns the selected path without evaluating it', async () => {
  vi.useFakeTimers();
  const h = pickerHelper();
  const promise = h.picker(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(19_000);
  h.ready();
  await vi.advanceTimersByTimeAsync(60_000);
  h.finish(JSON.stringify({ path: 'C:\\合成 DSH Home\\数据' }));
  await expect(promise).resolves.toBe('C:\\合成 DSH Home\\数据');
  expect(vi.getTimerCount()).toBe(0);
  expect(h.launch.mock.calls[0]![1]).toContain('-EncodedCommand');
  expect(h.launch.mock.calls[0]![2]).toMatchObject({ windowsHide: true });
  // The same dialog helper as the Vault binding, carrying this entry's own caption.
  expect(h.script()).toContain('选择 DSH 实例的数据目录（DSH Home）');
  expect(h.script()).not.toContain('__DSH_FOLDER_PICKER_TITLE__');
  expect(h.script()).toContain('DshVaultFolderPicker');
});

it('returns cancellation, refuses a non-Windows host and rejects invalid output', async () => {
  const h = pickerHelper();
  const cancelled = h.picker(new AbortController().signal);
  h.ready();
  h.finish(JSON.stringify({ path: null }));
  await expect(cancelled).resolves.toBeNull();
  await expect(createWindowsInstanceFolderPicker({ platform: 'linux' })(new AbortController().signal)).rejects.toThrow('Windows 本机桌面');
  for (const output of ['not json', '{"path":""}', '{"path":123}', '{"path":null,"extra":true}']) {
    const h2 = pickerHelper();
    const promise = h2.picker(new AbortController().signal);
    h2.finish(output);
    await expect(promise).rejects.toThrow('文件夹选择结果无效');
  }
});

it('aborts only its own helper when the caller disconnects', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const h = pickerHelper();
  const promise = h.picker(controller.signal);
  controller.abort();
  await expect(promise).rejects.toThrow();
  expect(h.aborted()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('derives the instance identity, profiles, runtime version and program root from the folder alone', async () => {
  const home = await syntheticHome();
  const inspected = await inspectInstanceFolder(home.homeRoot);
  expect(inspected.homeRoot).toBe(home.homeRoot);
  expect(inspected.runtimeVersion).toBe(runtimeVersion);
  expect(inspected.versionRoot).toBe(home.versionRoot);
  expect(inspected.cliPath).toBe(join(home.versionRoot, 'node_modules', cliPackage, 'lib', 'bin.js'));
  // `link:` names a path, so there is no stated version to compare with the install.
  expect(inspected.declaredRuntimeVersion).toBeNull();
  expect(inspected.profiles).toEqual([{ profileId: 'web', root: home.profileRoot, web: true }]);
  // Nothing was skipped in a Home that holds exactly one real profile.
  expect(inspected.skippedEntries).toEqual([]);
  // Offered from the folder name only; the caller still decides the final id.
  expect(inspected.suggestedInstanceId).toBe('my-dsh-home');
  // A read-only check writes nothing inside the selected folder.
  await expect(readFile(join(home.homeRoot, 'standalone-instances.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reports a stated version and refuses one that contradicts the installed runtime', async () => {
  const home = await syntheticHome();
  await writeProfileManifest(home, { declareRuntime: true, statedVersion: runtimeVersion, bundles: ['@deepseek-ai/dsh-base'] });
  const stated = await inspectInstanceFolder(home.homeRoot);
  expect(stated.runtimeVersion).toBe(runtimeVersion);
  expect(stated.declaredRuntimeVersion).toBe(runtimeVersion);
  // Without a reachable install the stated version is all the folder can offer.
  await writeProfileManifest(home, { declareRuntime: true, statedVersion: '0.1.5-rc.2', bundles: ['@deepseek-ai/dsh-base'] });
  const unreachable = await inspectInstanceFolder(home.homeRoot);
  expect(unreachable.runtimeVersion).toBe('0.1.5-rc.2');
  expect(unreachable.versionRoot).toBeNull();
  // A stated version that is not supported is refused rather than passed on.
  await writeProfileManifest(home, { declareRuntime: true, statedVersion: '0.1.2-alpha.9', bundles: ['@deepseek-ai/dsh-base'] });
  await expect(inspectInstanceFolder(home.homeRoot)).rejects.toThrow('尚未验证接入');
});

it('reports the version it actually resolved from the program folder', async () => {
  const home = await syntheticHome();
  // The linked manifest is the authority: it states 0.1.5-rc.2 while the folder holds 0.1.2-rc.1.
  await writeFile(join(home.versionRoot, 'node_modules', cliPackage, 'package.json'), JSON.stringify({ name: cliPackage, version: '0.1.5-rc.2' }));
  const inspected = await inspectInstanceFolder(home.homeRoot);
  expect(inspected.runtimeVersion).toBe('0.1.5-rc.2');
  expect(inspected.versionRoot).toBe(home.versionRoot);
  // A path declaration carries no version, so nothing is compared against it.
  expect(inspected.declaredRuntimeVersion).toBeNull();
});

it('skips a profile that declares no program instead of failing the whole folder', async () => {
  // A profile that names no program at all cannot become an instance. On a real Home such a
  // directory sits next to the usable one and must not condemn it.
  const home = await syntheticHome({ declareRuntime: false });
  const desktop = join(home.homeRoot, 'profiles', 'web-desktop');
  await mkdir(desktop, { recursive: true });
  await json(join(desktop, 'package.json'), { name: 'dsh-profile-web-desktop', devDependencies: { [cliPackage]: `link:${join(home.versionRoot, 'node_modules', cliPackage)}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } });
  const inspected = await inspectInstanceFolder(home.homeRoot);
  expect(inspected.profiles.map(profile => profile.profileId)).toEqual(['web-desktop']);
  expect(inspected.skippedEntries).toEqual([{ entry: 'web', reason: `清单未声明 ${cliPackage}（路径或版本），无法确定这个配置要用哪个 DSH 程序。` }]);
  // With nothing left to attach, the same directory is reported as the reason the folder failed.
  const only = await syntheticHome({ declareRuntime: false });
  await expect(inspectInstanceFolder(only.homeRoot)).rejects.toMatchObject({ code: 'INSTANCE_FOLDER_INVALID' });
  await expect(inspectInstanceFolder(only.homeRoot)).rejects.toThrow('清单未声明');
});

it('skips a generated directory under profiles/ such as node_modules, and still finds the real profiles', async () => {
  const home = await syntheticHome();
  // DSH creates this itself; its name is a legal profile id, so the name alone proves nothing.
  const generated = join(home.homeRoot, 'profiles', 'node_modules');
  await mkdir(join(generated, '.pnpm'), { recursive: true });
  // A directory with a manifest that is not a profile manifest is skipped for its own reason.
  const notAProfile = join(home.homeRoot, 'profiles', 'headless');
  await mkdir(notAProfile, { recursive: true });
  await json(join(notAProfile, 'package.json'), { name: 'unrelated', private: true });
  const inspected = await inspectInstanceFolder(home.homeRoot);
  // The real profile is still reached, with its program resolved.
  expect(inspected.profiles.map(profile => profile.profileId)).toEqual(['web']);
  expect(inspected.runtimeVersion).toBe(runtimeVersion);
  expect(inspected.versionRoot).toBe(home.versionRoot);
  expect(inspected.skippedEntries).toEqual([
    { entry: 'headless', reason: '清单未声明 dsh.profile.bundles，不是 DSH 配置目录。' },
    { entry: 'node_modules', reason: '缺少可读取的 profile 清单（package.json），不是 DSH 配置目录。' },
  ]);
});

it('reports a folder with no usable profile at all as a failure, naming what it skipped', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-instance-folder-unusable-'));
  roots.push(home);
  await mkdir(join(home, 'profiles', 'node_modules'), { recursive: true });
  await expect(inspectInstanceFolder(home)).rejects.toThrow('没有可接入的 DSH 配置');
  await expect(inspectInstanceFolder(home)).rejects.toThrow('node_modules（缺少可读取的 profile 清单');
});

it('enumerates every installed profile and marks which of them is a Web profile', async () => {
  const home = await syntheticHome();
  const desktop = join(home.homeRoot, 'profiles', 'web-desktop');
  await mkdir(desktop, { recursive: true });
  await json(join(desktop, 'package.json'), { name: 'dsh-profile-web-desktop', devDependencies: { [cliPackage]: `link:${join(home.versionRoot, 'node_modules', cliPackage)}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } });
  const inspected = await inspectInstanceFolder(home.homeRoot);
  expect(inspected.profiles.map(profile => profile.profileId)).toEqual(['web', 'web-desktop']);
  expect(inspected.profiles[0]!.web).toBe(true);
  expect(inspected.profiles[1]!.web).toBe(false);
});

it('refuses a folder that is not a complete DSH Home', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'dsh-instance-folder-empty-'));
  roots.push(empty);
  await expect(inspectInstanceFolder('relative\\home')).rejects.toThrow('完整文件夹路径');
  await expect(inspectInstanceFolder(join(empty, 'missing'))).rejects.toThrow('不存在或无法访问');
  await expect(inspectInstanceFolder(empty)).rejects.toThrow('缺少 profiles 文件夹');
  await mkdir(join(empty, 'profiles'));
  await expect(inspectInstanceFolder(empty)).rejects.toThrow('尚未安装任何 DSH 配置');
  await mkdir(join(empty, 'profiles', 'web'), { recursive: true });
  // A directory without a profile manifest is skipped rather than fatal; with no other profile
  // left, the folder is still refused and the reason names the directory that was skipped.
  await expect(inspectInstanceFolder(empty)).rejects.toThrow('没有可接入的 DSH 配置');
  await expect(inspectInstanceFolder(empty)).rejects.toThrow('web（缺少可读取的 profile 清单');
  const noEntry = await syntheticHome({ cliEntry: false });
  // The program is declared but its launcher is missing: that is a broken install, not a
  // directory to skip silently.
  await expect(inspectInstanceFolder(noEntry.homeRoot)).rejects.toThrow('缺少官方启动程序');
  const unsupported = await syntheticHome();
  await json(join(unsupported.versionRoot, 'node_modules', cliPackage, 'package.json'), { name: cliPackage, version: '0.1.2-alpha.9' });
  await expect(inspectInstanceFolder(unsupported.homeRoot)).rejects.toThrow('尚未验证接入');
});

it('refuses two profiles that would attach different program directories', async () => {
  const home = await syntheticHome();
  // A second program folder of a different version, declared by a second profile.
  const otherRuntime = join(home.root, 'runtime-other');
  await json(join(otherRuntime, 'node_modules', cliPackage, 'package.json'), { name: cliPackage, version: '0.1.5-rc.2' });
  await mkdir(join(otherRuntime, 'node_modules', cliPackage, 'lib'), { recursive: true });
  await writeFile(join(otherRuntime, 'node_modules', cliPackage, 'lib', 'bin.js'), '// synthetic CLI');
  const otherProfile = join(home.homeRoot, 'profiles', 'web-desktop');
  await mkdir(otherProfile, { recursive: true });
  await json(join(otherProfile, 'package.json'), { name: 'dsh-profile-web-desktop', devDependencies: { [cliPackage]: `link:${join(otherRuntime, 'node_modules', cliPackage)}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } });
  // A skipped directory does not take part in the agreement check: it has no program to disagree
  // with, so the two usable profiles are still what decides the outcome.
  await mkdir(join(home.homeRoot, 'profiles', 'node_modules'), { recursive: true });
  await expect(inspectInstanceFolder(home.homeRoot)).rejects.toMatchObject({ code: 'INSTANCE_FOLDER_INVALID' });
  await expect(inspectInstanceFolder(home.homeRoot)).rejects.toThrow('不同的 DSH 程序目录');
});

it('does not read a Launcher catalog while inspecting a folder', async () => {
  const home = await syntheticHome();
  // A Launcher catalog placed next to the home must not take part in the check.
  const launcher = join(home.homeRoot, '..', 'launcher');
  await json(join(launcher, 'config.json'), { homes: [], versions: [], instances: [] });
  const inspected = await inspectInstanceFolder(home.homeRoot);
  expect(inspected.versionRoot).toBe(home.versionRoot);
  expect(JSON.parse(await readFile(join(launcher, 'config.json'), 'utf8')).instances).toEqual([]);
});
