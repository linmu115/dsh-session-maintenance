import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** Host adapter only: the Engine exposes no process-launch operation. */
export async function installedEngineStartCommand(stateRoot: string, platform: NodeJS.Platform = process.platform) {
  if (platform !== 'win32') throw new Error('此安装尚未提供当前系统的看板启动器');
  const registeredRoot = await realpath(stateRoot);
  const installationPath = join(registeredRoot, 'engine-installation.json');
  let installation: unknown;
  try { installation = JSON.parse(await readFile(installationPath, 'utf8')); }
  catch { throw new Error('Maintenance 安装记录不可用，请先修复引擎安装'); }
  if (typeof installation !== 'object' || installation === null) throw new Error('Maintenance 安装记录无效');
  const record = installation as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.entry !== 'string' || typeof record.program !== 'string'
    || typeof record.stateRoot !== 'string' || !isAbsolute(record.entry) || !isAbsolute(record.program)
    || !isAbsolute(record.stateRoot)) throw new Error('Maintenance 安装记录无效');
  const declaredRoot = await realpath(record.stateRoot).catch(() => undefined);
  if (declaredRoot?.toLowerCase() !== registeredRoot.toLowerCase()) throw new Error('Maintenance 状态目录与安装记录不一致');
  const entry = await realpath(record.entry).catch(() => undefined);
  const program = await realpath(record.program).catch(() => undefined);
  if (!entry || !program || basename(entry) !== 'dsh-session-maint.mjs' || basename(dirname(entry)) !== 'engine'
    || basename(program).toLowerCase() !== 'node.exe') throw new Error('Maintenance 引擎程序未通过安装记录校验');
  const script = await realpath(join(dirname(dirname(entry)), 'windows-maintenance', 'Start-Session-Maintenance-Detached.ps1')).catch(() => undefined);
  if (!script) throw new Error('Maintenance 安装包缺少本机启动器');
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error('Windows 系统目录不可用，无法启动 Maintenance');
  return {
    command: resolve(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-InstallationConfig', installationPath],
  };
}

export async function startInstalledEngine(stateRoot: string): Promise<void> {
  const target = await installedEngineStartCommand(stateRoot);
  await new Promise<void>((resolveStart, reject) => {
    const child = spawn(target.command, target.args, { windowsHide: true, stdio: 'ignore', signal: AbortSignal.timeout(210_000) });
    child.once('error', () => reject(new Error('无法调用已安装的 Maintenance 启动器')));
    child.once('exit', code => code === 0 ? resolveStart() : reject(new Error('Maintenance 引擎未能启动，请检查本机引擎日志')));
  });
}
