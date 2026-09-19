import { IntegrationError } from "./integrations/bindings.js";
import { execFile } from 'node:child_process';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
// Fixed script only: selected paths never become executable PowerShell text.
export const FOLDER_PICKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
$dialog.Description = '选择已安装 Obsidian Bridge 的 Vault 文件夹'
$dialog.ShowNewFolderButton = $false
try {
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    @{ path = $dialog.SelectedPath } | ConvertTo-Json -Compress
  } else { @{ path = $null } | ConvertTo-Json -Compress }
} finally { $dialog.Dispose() }
`;
export type VaultFolderPicker = (signal: AbortSignal) => Promise<string | null>;
export function createWindowsVaultFolderPicker(options: { platform?: string; timeoutMs?: number; execute?: typeof execFile } = {}): VaultFolderPicker {
  return async signal => {
    signal.throwIfAborted();
    if ((options.platform ?? process.platform) !== 'win32') throw new IntegrationError("VAULT_FOLDER_INVALID", '选择文件夹功能需要 Windows 本机桌面');
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 60_000)]);
    const output = await new Promise<string>((resolve, reject) => {
      (options.execute ?? execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-NonInteractive', '-EncodedCommand', Buffer.from(FOLDER_PICKER_SCRIPT, 'utf16le').toString('base64')],
        { windowsHide: true, encoding: 'utf8', maxBuffer: 32_768, signal: deadline }, (error, stdout) => {
          if (error) reject(new IntegrationError("VAULT_FOLDER_INVALID", deadline.aborted ? '选择文件夹已取消或超时，请重新操作' : '无法打开 Windows 文件夹选择框'));
          else resolve(String(stdout));
        });
    });
    deadline.throwIfAborted();
    return z.object({ path: z.string().min(1).max(32_768).nullable() }).strict().parse(JSON.parse(output.trim())).path;
  };
}

export async function readSmallJson(path: string): Promise<unknown> {
  const file = await open(path, 'r');
  try {
    // Bounded read, including files concurrently replaced or extended by another process.
    const buffer = Buffer.alloc(1_048_577);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1_048_576) throw new IntegrationError("VAULT_FOLDER_INVALID", 'Vault 插件配置过大，无法验证');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await file.close(); }
}
export async function inspectVaultFolder(selected: string): Promise<{ root: string; vaultId: string }> {
  if (!isAbsolute(selected)) throw new IntegrationError("VAULT_FOLDER_INVALID", '请选择 Vault 的完整文件夹路径');
  const root = await realpath(selected).catch(() => { throw new IntegrationError("VAULT_FOLDER_INVALID", '所选文件夹不存在或无法访问'); });
  if (!(await stat(join(root, '.obsidian')).catch(() => undefined))?.isDirectory()) throw new IntegrationError("VAULT_FOLDER_INVALID", '所选文件夹不是 Obsidian Vault：缺少 .obsidian 文件夹');
  const plugin = join(root, '.obsidian', 'plugins', 'obsidian-deepharness-bridge');
  try {
    const manifest = z.object({ id: z.literal('obsidian-deepharness-bridge'), version: z.literal("0.7.0-rc2.4") }).parse(await readSmallJson(join(plugin, 'manifest.json')));
    if (!manifest || !(await stat(join(plugin, 'main.js'))).isFile()) throw new IntegrationError("VAULT_FOLDER_INVALID", 'missing entry');
  } catch { throw new IntegrationError("VAULT_FOLDER_INVALID", '此 Vault 未完整安装 Obsidian Bridge 插件，需要兼容的 Obsidian Bridge 0.7.0-rc2.4 插件'); }
  try {
    const data = z.object({ vaultId: z.string().min(1).max(256) }).parse(await readSmallJson(join(plugin, 'data.json')));
    return { root, vaultId: data.vaultId };
  } catch { throw new IntegrationError("VAULT_FOLDER_INVALID", '此 Vault 尚无有效 Bridge 身份，请在 Obsidian 打开此 Vault 并启用 Bridge 后重试'); }
}
