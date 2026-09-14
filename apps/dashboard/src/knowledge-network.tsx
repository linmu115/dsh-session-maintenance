import { useEffect, useState } from 'react';
import { Button, Surface } from '@linmu/dsh-session-ui';
import type { NetworkPage, NetworkImpact, RunCenterItem } from '@linmu/dsh-session-contracts';
export interface KnowledgeNetworkApi {
  listProjectionRuns(signal?: AbortSignal): Promise<readonly RunCenterItem[]>;
  queryKnowledgeNetwork(runId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<NetworkPage>;
  queryKnowledgeImpact(runId: string, logicalSessionId: string, signal?: AbortSignal): Promise<NetworkImpact>;
}
export function KnowledgeNetworkView({ api, onOpenSession }: { api: KnowledgeNetworkApi; onOpenSession(id: string): void }) {
  const [runs, setRuns] = useState<readonly RunCenterItem[]>([]), [runId, setRunId] = useState('');
  const [query, setQuery] = useState(''), [kind, setKind] = useState('all'), [deleted, setDeleted] = useState(false);
  const [page, setPage] = useState<NetworkPage>(), [impact, setImpact] = useState<NetworkImpact>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api.listProjectionRuns(controller.signal).then(value => { if (!controller.signal.aborted) { const active = value.filter(v => v.run.state === 'running'); setRuns(active); setRunId(active[0]?.run.id ?? ''); } }, e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [api]);
  const perform = async (work: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const load = (after?: string) => perform(async () => { const result = await api.queryKnowledgeNetwork(runId, { query, kind, includeDeleted: deleted, ...(after ? { after } : {}) }); setPage(old => after && old ? { ...result, items: [...old.items, ...result.items] } : result); });
  return <Surface><h3>全局维护网络</h3><p>选择运行实例，查询全部画布与关联对象。扩展停用后可查看目录；恢复、删除和冲突处理使用下方对应数据面板。</p>
    {error && <p role="alert">{error}</p>}<div className="filter-row"><select aria-label="知识网络实例" value={runId} onChange={e => { setRunId(e.target.value); setPage(undefined); setImpact(undefined); }}>{runs.map(r => <option key={r.run.id} value={r.run.id}>{r.run.instanceId} · {r.run.profileId}</option>)}</select><input aria-label="网络搜索" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索标题" /><select aria-label="网络对象类型" value={kind} onChange={e => setKind(e.target.value)}><option value="all">全部类型</option><option value="session">会话</option><option value="canvas">画布</option><option value="sticker">贴纸</option><option value="note">笔记链接</option></select><label><input type="checkbox" checked={deleted} onChange={e => setDeleted(e.target.checked)} />含已删除</label><Button disabled={busy || !runId} onClick={() => void load()}>查询网络</Button></div>
    {!runId && <p>启动一个接入 Maintenance 的实例后可查询它的会话网络。</p>}
    {page?.items.map(item => <div key={item.key} className="extension-object-row"><strong>{item.title || '未命名对象'}</strong> · {item.deleted ? '已删除' : item.available ? '可用' : '已停用'}{item.conflicts ? ` · ${item.conflicts} 个冲突` : ''}{item.logicalSessionIds.slice(0,10).map(id => <span key={id}><Button onClick={() => onOpenSession(id)}>打开关联会话</Button><Button disabled={busy} onClick={() => void perform(async () => setImpact(await api.queryKnowledgeImpact(runId, id)))}>查看影响</Button></span>)}</div>)}
    {page?.nextCursor && <Button disabled={busy} onClick={() => void load(page.nextCursor!)}>加载更多</Button>}
    {impact && <section><h4>来源更新与影响</h4><p>此处只标记关联。需重新回答时，在 DSH 的“全局维护网络”选择目标会话并检查发送。</p>{impact.items.map((item,index) => <p key={item.referenceId + index}><Button onClick={() => onOpenSession(item.targetSessionId)}>{item.title}</Button> · {item.depth > 1 ? '间接关联 · ' : ''}{item.status === 'new-content' ? '来源有新内容' : item.status === 'fixed' ? '固定引用有效' : '来源不可用'}</p>)}{impact.truncated && <p>已达到本次查询额度，可从关联会话继续查看。</p>}</section>}
  </Surface>;
}

