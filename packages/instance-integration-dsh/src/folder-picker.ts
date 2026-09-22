import { IntegrationError } from "./bindings.js";
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { folderPickerScript } from './folder-script.js';

/**
 * Native Windows folder chooser shared by every "select a folder to connect"
 * entry. The domain-specific part is only the dialog title, so the vault and the
 * instance pickers run the same helper and the same readiness contract instead of
 * keeping two copies of the dialog code.
 */
export interface NativeFolderPickerOptions {
  readonly platform?: string;
  readonly timeoutMs?: number;
  readonly selectionTimeoutMs?: number;
  readonly execute?: typeof execFile;
  /** Shown as the dialog title; never used to evaluate the selection. */
  readonly title: string;
  /** Line the helper writes to stderr once the dialog is actually open. */
  readonly readyToken: string;
  /** Rejected with this code; the folder itself is only judged by its caller. */
  readonly errorCode: string;
}

export function createWindowsFolderPicker(options: NativeFolderPickerOptions): (signal: AbortSignal) => Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const selectionTimeoutMs = options.selectionTimeoutMs ?? 600_000;
  const script = folderPickerScript(options.title);
  const args = ['-NoLogo', '-NoProfile', '-STA', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  return async signal => {
    signal.throwIfAborted();
    if ((options.platform ?? process.platform) !== 'win32') throw new IntegrationError(options.errorCode, '选择文件夹功能需要 Windows 本机桌面');
    const abort = new AbortController();
    let stage: 'opening' | 'selecting' = 'opening';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => abort.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => abort.abort(new Error('picker timeout')), ms);
      timer.unref();
    };
    arm(timeoutMs);
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = (options.execute ?? execFile)('powershell.exe', args,
          { windowsHide: true, encoding: 'utf8', maxBuffer: 32_768, signal: abort.signal }, (error, stdout) => {
            if (error || abort.signal.aborted) {
              const message = signal.aborted ? '已取消选择文件夹'
                : abort.signal.aborted ? stage === 'opening'
                  ? 'Windows 文件夹窗口未能及时打开，已取消本次选择。请重试。'
                  : '选择文件夹等待超时，窗口已关闭。请重新选择。'
                : '无法打开 Windows 文件夹选择框';
              reject(new IntegrationError(options.errorCode, message));
            } else resolve(String(stdout));
          });
        let pending = '';
        child.stderr?.on('data', (chunk: Buffer | string) => {
          pending += String(chunk);
          const lines = pending.split(/\r?\n/u);
          pending = lines.pop()!.slice(-256);
          if (!abort.signal.aborted && stage === 'opening' && lines.includes(options.readyToken)) {
            stage = 'selecting';
            arm(selectionTimeoutMs);
          }
        });
      });
      signal.throwIfAborted();
      try { return z.object({ path: z.string().min(1).max(32_768).nullable() }).strict().parse(JSON.parse(output.trim())).path; }
      catch { throw new IntegrationError(options.errorCode, '文件夹选择结果无效，请重新选择'); }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    }
  };
}
