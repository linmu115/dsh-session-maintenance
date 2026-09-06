import { useEffect, useRef, useState } from "react";

import type { CanonicalSessionRestoreResult, RecentlyDeletedSession } from "@linmu/dsh-session-contracts";
import { Badge, Button, EmptyState, LoadingState, Surface } from "@linmu/dsh-session-ui";

export interface RecentlyDeletedApi {
  listRecentlyDeleted(signal?: AbortSignal): Promise<readonly RecentlyDeletedSession[]>;
  restoreCanonicalSession(id: string, signal?: AbortSignal): Promise<CanonicalSessionRestoreResult>;
}

export function RecentlyDeletedPage(props: { readonly api: RecentlyDeletedApi; readonly onOpenSession: (id: string) => void; readonly onRestored?: () => void }) {
  const [items, setItems] = useState<readonly RecentlyDeletedSession[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [retry, setRetry] = useState(0);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const load = async (signal?: AbortSignal) => {
    const next = await props.api.listRecentlyDeleted(signal);
    if (!signal?.aborted) setItems(next);
  };
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    setError(undefined);
    void load(controller.signal).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "最近删除不可用"); });
    return () => controller.abort();
  }, [props.api, retry]);
  const restore = async (id: string) => {
    if (busyId !== undefined) return;
    const signal = lifetime.current?.signal;
    setBusyId(id); setError(undefined); setNotice(undefined);
    try {
      await props.api.restoreCanonicalSession(id, signal);
      if (signal?.aborted) return;
      setNotice("会话已恢复，可回到会话页继续阅读。"); props.onRestored?.();
      try { await load(signal); }
      catch (reason) { if (!signal?.aborted) setError(`会话已恢复，但列表更新失败：${reason instanceof Error ? reason.message : "请重新读取"}`); }
    } catch (reason) { if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "恢复失败"); }
    finally { if (!signal?.aborted) setBusyId(undefined); }
  };
  return <Surface title="最近删除" action={<Button disabled={busyId !== undefined} onClick={() => setRetry((value) => value + 1)}>重新读取最近删除</Button>}>
    <div className="settings-content"><p>恢复已删除会话会撤销删除，让它重新出现在会话列表中；不会将正文回退到某个历史版本。</p>
      {error === undefined ? null : <p role="alert" className="inline-error">{error}</p>}
      {notice === undefined ? null : <p role="status">{notice}</p>}
      {items === undefined && error === undefined ? <LoadingState label="正在读取最近删除…" /> : null}
      {items?.length === 0 ? <EmptyState title="没有最近删除的会话" description="待删除和已删除会话会出现在这里。" /> : <div className="deleted-session-list">
        {items?.map((item) => <article key={item.session.id} data-testid={`recently-deleted-${item.session.id}`}>
          <div><strong>{item.session.title || "未命名会话"}</strong><details><summary>会话标识</summary><code>{item.session.id}</code></details></div>
          <div>{item.tombstone === null ? <Badge tone="warning">等待 {item.pendingOperations} 项写入</Badge> : <Badge>已删除</Badge>}</div>
          <div className="deleted-session-actions"><Button onClick={() => props.onOpenSession(item.session.id)}>静态查看</Button><Button disabled={busyId !== undefined} onClick={() => void restore(item.session.id)}>{busyId === item.session.id ? "正在恢复…" : "恢复已删除会话"}</Button></div>
        </article>)}
      </div>}
    </div>
  </Surface>;
}
