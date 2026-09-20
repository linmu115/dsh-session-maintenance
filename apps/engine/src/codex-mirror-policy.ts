import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { codexMirrorPreferencesSchema, type CodexMirrorPreferences, type CodexMirrorCheck, type CodexMirrorStatus } from '@linmu/dsh-session-contracts';

export class CodexMirrorPolicy {
  private preferences = codexMirrorPreferencesSchema.parse({});
  private result: CodexMirrorCheck | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly stateRoot: string, private readonly inspect: (preferences: CodexMirrorPreferences) => Promise<CodexMirrorCheck>) {}
  async initialize() {
    try { this.preferences = codexMirrorPreferencesSchema.parse(JSON.parse(await readFile(join(this.stateRoot, 'codex-mirror.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (this.preferences.mirror || this.preferences.bidirectional || this.preferences.background) await this.check();
  }
  status(): CodexMirrorStatus {
    const compatible = this.result?.compatible === true;
    return { preferences: { ...this.preferences }, check: this.result && { ...this.result }, active: {
      mirror: compatible && this.preferences.mirror,
      bidirectional: compatible && this.result!.bidirectional && this.preferences.bidirectional,
      background: compatible && this.preferences.background && (this.preferences.mirror || (this.result!.bidirectional && this.preferences.bidirectional)),
    } };
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> { const work = this.tail.then(operation); this.tail = work.catch(() => {}); return work; }
  private async inspectCurrent() {
    try { this.result = await this.inspect({ ...this.preferences }); }
    catch { this.result = { compatible: false, bidirectional: false, reason: 'Codex 检查失败；请核对程序、目录和会话格式。' }; }
    return this.status();
  }
  check() { return this.serialize(() => this.inspectCurrent()); }
  configure(input: CodexMirrorPreferences) {
    return this.serialize(async () => {
      const next = codexMirrorPreferencesSchema.parse(input), previous = this.preferences;
      if (next.executable !== previous.executable || next.instanceId !== previous.instanceId) this.result = null;
      for (const key of ['mirror', 'bidirectional', 'background'] as const) if (next[key] && !previous[key] && !this.result?.compatible) throw new Error('请先检查 Codex 程序版本、数据目录及会话结构，再开启功能');
      if (next.bidirectional && !previous.bidirectional && !this.result?.bidirectional) throw new Error('当前 Codex adapter 不提供双向维护；实验性能力保持关闭');
      await mkdir(this.stateRoot, { recursive: true });
      const path = join(this.stateRoot, 'codex-mirror.json'), temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' }); await rename(temporary, path);
      this.preferences = next;
      return this.status();
    });
  }
  async assertMirror() { const status = await this.check(); if (!status.active.mirror) throw new Error('Codex 镜像未启用或兼容检查未通过；其它维护功能可继续使用'); }
}
