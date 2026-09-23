import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { installedEngineStartCommand } from '../src/installed-engine-starter.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'maintenance-starter-'));
  roots.push(root);
  const stateRoot = join(root, 'state');
  const release = join(root, 'release');
  const entry = join(release, 'engine', 'dsh-session-maint.mjs');
  const program = join(root, 'node.exe');
  await mkdir(stateRoot);
  await mkdir(join(release, 'engine'), { recursive: true });
  await mkdir(join(release, 'windows-maintenance'), { recursive: true });
  await writeFile(entry, '');
  await writeFile(program, '');
  await writeFile(join(release, 'windows-maintenance', 'Start-Session-Maintenance.ps1'), '');
  await writeFile(join(release, 'windows-maintenance', 'Start-Session-Maintenance-Detached.ps1'), '');
  const record = { schemaVersion: 1, entry, program, stateRoot };
  const installationPath = join(stateRoot, 'engine-installation.json');
  await writeFile(installationPath, JSON.stringify(record));
  return { root, stateRoot, release, record, installationPath };
}

it('uses the registered standalone Engine starter rather than a Launcher command', async () => {
  const f = await fixture();
  const command = await installedEngineStartCommand(f.stateRoot, 'win32');
  expect(command.command.toLowerCase()).toMatch(/powershell\.exe$/);
  expect(command.args).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    await realpath(join(f.release, 'windows-maintenance', 'Start-Session-Maintenance-Detached.ps1')),
    '-InstallationConfig', f.installationPath]);
});

it('rejects an installation record pointing at another state root', async () => {
  const f = await fixture();
  await writeFile(f.installationPath, JSON.stringify({ ...f.record, stateRoot: f.release }));
  await expect(installedEngineStartCommand(f.stateRoot, 'win32')).rejects.toThrow('状态目录');
});

it('rejects non-Windows installations without starting a process', async () => {
  const f = await fixture();
  await expect(installedEngineStartCommand(f.stateRoot, 'linux')).rejects.toThrow('当前系统');
});
