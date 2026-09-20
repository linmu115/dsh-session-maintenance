import { useEffect, useState } from 'react';
import type { InstalledAdapterEntry } from '@linmu/dsh-session-contracts';
export interface AdapterCatalogApi {
  listInstalledAdapters?(): Promise<{ entries: InstalledAdapterEntry[]; issues: { directory: string; message: string }[]; requiresRestart: boolean }>;
  setInstalledAdapterEnabled?(id: string, enabled: boolean): Promise<unknown>;
}
export function AdapterCatalogView({ api }: { api: AdapterCatalogApi }) {
  const [catalog, setCatalog] = useState<Awaited<ReturnType<NonNullable<AdapterCatalogApi['listInstalledAdapters']>>>>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => { let active = true; void api.listInstalledAdapters?.().then(value => { if (active) setCatalog(value); }, error => { if (active) setError(String(error)); }); return () => { active = false; }; }, [api, revision]);
  if (!api.listInstalledAdapters) return null;
  const toggle = async (entry: InstalledAdapterEntry) => {
    setBusy(true); setError('');
    try { await api.setInstalledAdapterEnabled?.(entry.id, !entry.enabled); setRevision(value => value + 1); }
    catch (error) { setError(error instanceof Error ? error.message : '无法更新适配器设置'); }
    finally { setBusy(false); }
  };
  return <details><summary>已安装的适配器</summary><p>发现不会自动启用。选择按适配器分别保存，重启 Maintenance 后加载；停用不删除会话扩展数据。</p>
    <button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>重新发现</button>
    {catalog?.entries.map(entry => <p key={entry.id}><label><input type="checkbox" disabled={busy || !api.setInstalledAdapterEnabled} checked={entry.enabled} onChange={() => { void toggle(entry); }}/>{entry.id} · {entry.kind === 'instance' ? '实例适配' : entry.namespace} · {entry.version}</label>（{entry.enabled ? '配置为启用' : '未启用'}，运行状态需重启后验证）</p>)}
    {catalog?.entries.length === 0 ? <p>未发现外部适配器。将发行包解压到维护数据目录的 adapters 子目录后重新发现。</p> : null}
    {catalog?.issues.map(issue => <p role="alert" key={issue.directory}>{issue.directory}：{issue.message}</p>)}
    {error ? <p role="alert">{error}</p> : null}
  </details>;
}
