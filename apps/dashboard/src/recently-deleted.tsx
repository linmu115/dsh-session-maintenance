import { useEffect, useState } from "react";

import type { CanonicalSessionRestoreResult, RecentlyDeletedSession } from "@linmu/dsh-session-contracts";
import { Badge, Button, EmptyState, LoadingState, Surface } from "@linmu/dsh-session-ui";

export interface RecentlyDeletedApi {
  listRecentlyDeleted(signal?: AbortSignal): Promise<readonly RecentlyDeletedSession[]>;
  restoreCanonicalSession(id: string, signal?: AbortSignal): Promise<CanonicalSessionRestoreResult>;
}

export function RecentlyDeletedPage(props: { readonly api: RecentlyDeletedApi; readonly onOpenSession: (id: string) => void }) {
  const [items, setItems] = useState<readonly RecentlyDeletedSession[]>();
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const load = async (signal?: AbortSignal) => setItems(await props.api.listRecentlyDeleted(signal));
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "最近删除不可用"));
    return () => controller.abort();
  }, [props.api]);
  const restore = async (id: string) => {
    setBusyId(id); setError(undefined);
    try { await props.api.restoreCanonicalSession(id); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "恢复失败"); }
    finally { setBusyId(undefined); }
  };
  if (items === undefined && error === undefined) return <Surface><LoadingState label="正在读取最近删除…" /></Surface>;
  return <>
    <div className="dsm-page-heading"><div><h2>最近删除</h2><p>删除是带 Checkpoint 的逻辑墓碑；恢复不会改写旧历史。</p></div></div>
    <Surface>
      {error === undefined ? null : <p className="inline-error">{error}</p>}
      {items?.length === 0 ? <EmptyState title="没有最近删除的会话" description="待删除和已删除会话会出现在这里。" /> : <div className="deleted-session-list">
        {items?.map((item) => <article key={item.session.id} data-testid={`recently-deleted-${item.session.id}`}>
          <div><strong>{item.session.title || "未命名会话"}</strong><code>{item.session.id}</code></div>
          <div>{item.tombstone === null ? <Badge tone="warning">等待 {item.pendingOperations} 项写入</Badge> : <Badge>已删除</Badge>}</div>
          <div className="deleted-session-actions"><Button onClick={() => props.onOpenSession(item.session.id)}>静态查看</Button><Button disabled={busyId === item.session.id} onClick={() => void restore(item.session.id)}>恢复</Button></div>
        </article>)}
      </div>}
    </Surface>
  </>;
}
