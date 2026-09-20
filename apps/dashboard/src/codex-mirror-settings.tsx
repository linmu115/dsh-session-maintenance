import { useEffect, useState } from 'react';
import type { CodexMirrorPreferences, CodexMirrorStatus } from '@linmu/dsh-session-contracts';
export interface CodexMirrorApi {
  getCodexMirror?(): Promise<CodexMirrorStatus>;
  checkCodexMirror?(): Promise<CodexMirrorStatus>;
  configureCodexMirror?(input: CodexMirrorPreferences): Promise<CodexMirrorStatus>;
}
export function CodexMirrorSettings({ api }: { api: CodexMirrorApi }) {
  const [status, setStatus] = useState<CodexMirrorStatus>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [instanceId, setInstanceId] = useState(''), [executable, setExecutable] = useState('');
  useEffect(() => { let active = true; void api.getCodexMirror?.().then(value => { if (active) { setStatus(value); setInstanceId(value.preferences.instanceId); setExecutable(value.preferences.executable); } }, error => { if (active) setError(String(error)); }); return () => { active = false; }; }, [api]);
  if (!api.getCodexMirror) return null;
  const run = async (work: () => Promise<CodexMirrorStatus | undefined>) => { setBusy(true); setError(''); try { const value = await work(); if (value) setStatus(value); } catch (error) { setError(error instanceof Error ? error.message : '检查失败'); } finally { setBusy(false); } };
  return <section aria-label="Codex 镜像能力"><h3>Codex 镜像能力</h3>
    <p>三项初始均关闭。开关选择会保存；每次启动和同步前重新检查。缺少 Codex 不影响其它维护功能。</p>
    <label>已登记的 Codex 来源 ID <input value={instanceId} onChange={event => setInstanceId(event.target.value)} /></label>
    <label>Codex 原生程序路径（留空从 PATH 查找） <input value={executable} onChange={event => setExecutable(event.target.value)} /></label>
    <button type="button" disabled={busy || !status} onClick={() => { void run(() => api.configureCodexMirror!({ ...status!.preferences, instanceId, executable, mirror: false, bidirectional: false, background: false })); }}>保存检查目标并关闭同步</button>
    <button type="button" disabled={busy || !status || executable !== status.preferences.executable || instanceId !== status.preferences.instanceId} onClick={() => { void run(() => api.checkCodexMirror!()); }}>检查本机 Codex</button>
    {status ? (['mirror', 'bidirectional', 'background'] as const).map(key => <p key={key}><label><input type="checkbox" checked={status.preferences[key]} disabled={busy || (!status.preferences[key] && (!status.check?.compatible || (key === 'bidirectional' && !status.check.bidirectional)))} onChange={event => { void run(() => api.configureCodexMirror!({ ...status.preferences, [key]: event.target.checked })); }}/>{{ mirror: '镜像同步', bidirectional: '双向维护（实验性）', background: '后台常驻' }[key]}</label> · {status.active[key] ? '已就绪' : status.preferences[key] ? '已记住选择，当前暂停' : '关闭'}</p>) : null}
    <p>{status?.check?.reason ?? '尚未检查。发现程序或目录不等于格式兼容。'}</p>
    <p>当前只读 Codex adapter 不提供双向维护，实验性选项不可开启。</p>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
