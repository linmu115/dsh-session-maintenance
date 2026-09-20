import { execFile } from 'node:child_process';
import { stat, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { CodexMirrorCheck, CodexMirrorPreferences, RegisteredInstance, SessionReadAdapter } from '@linmu/dsh-session-contracts';
const execute = promisify(execFile);
export async function checkCodexEnvironment(preferences: CodexMirrorPreferences, instances: readonly RegisteredInstance[], adapter: SessionReadAdapter): Promise<CodexMirrorCheck> {
  const instance = instances.find(item => item.id === preferences.instanceId && item.platform === 'codex');
  if (!instance) return { compatible: false, bidirectional: false, reason: '请先登记并选择 Codex 数据目录。' };
  let executable = preferences.executable;
  if (!executable) {
    for (const directory of (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)) {
      const candidate = join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
      if ((await stat(candidate).catch(() => undefined))?.isFile()) { executable = candidate; break; }
    }
  }
  if (!isAbsolute(executable) || /\.(cmd|bat|ps1)$/i.test(executable) || !(await stat(executable).catch(() => undefined))?.isFile()) return { compatible: false, bidirectional: false, reason: '未找到 Codex 原生程序，请配置可执行文件的完整路径。' };
  const versionText = await execute(await realpath(executable), ['--version'], { shell: false, windowsHide: true, timeout: 5000, maxBuffer: 4096 });
  const version = /\b(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?=\s|$)/.exec(versionText.stdout)?.[1];
  if (!version || version !== instance.platformVersion) return { compatible: false, bidirectional: false, ...(version ? { version } : {}), reason: '实际 Codex 程序版本与登记的格式版本不一致。' };
  const probe = await adapter.probe(instance);
  const compatible = probe.status === 'compatible';
  return { compatible, version, bidirectional: false, reason: compatible ? '程序版本、数据目录和会话格式检查通过。当前 adapter 提供单向镜像。' : 'Codex 会话结构不受当前 adapter 支持，请使用匹配的格式 adapter。' };
}
