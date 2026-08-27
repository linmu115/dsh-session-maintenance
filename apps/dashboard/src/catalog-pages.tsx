import { useEffect, useState } from "react";

import type { Checkpoint, Page, PlanQuery, PlanSummary, SyncPlan } from "@linmu/dsh-session-contracts";
import { Badge, Button, EmptyState, LoadingState, Surface, statusTone } from "@linmu/dsh-session-ui";
import { MarkdownView } from "@linmu/dsh-session-ui/markdown";

export interface CatalogApi {
  listPlans(query?: PlanQuery, signal?: AbortSignal): Promise<Page<PlanSummary>>;
  getPlan(id: string, signal?: AbortSignal): Promise<SyncPlan>;
  listCheckpoints(signal?: AbortSignal): Promise<readonly Checkpoint[]>;
}

export function PlansPage(props: { readonly api: CatalogApi }) {
  const [page, setPage] = useState<Page<PlanSummary>>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<SyncPlan>();
  useEffect(() => {
    const controller = new AbortController();
    void props.api.listPlans({ limit: 25 }, controller.signal).then(setPage, (reason: unknown) => setError(reason instanceof Error ? reason.message : "计划不可用"));
    return () => controller.abort();
  }, [props.api]);
  const loadMore = async () => {
    if (page?.nextCursor === undefined) return;
    const next = await props.api.listPlans({ cursor: page.nextCursor, limit: 25 });
    setPage({ items: [...page.items, ...next.items], ...(next.nextCursor === undefined ? {} : { nextCursor: next.nextCursor }) });
  };
  if (error !== undefined) return <Surface><EmptyState kind="warning" title="计划列表不可用" description={error} /></Surface>;
  if (page === undefined) return <Surface><LoadingState label="正在读取计划摘要…" /></Surface>;
  return <>
    <div className="dsm-page-heading"><div><h2>同步计划</h2><p>计划由会话工作台生成；此页只读取摘要，点击后再读取完整步骤。</p></div></div>
    <div className="catalog-layout">
      <Surface title={`${page.items.length} 个计划`} action={page.nextCursor === undefined ? null : <Button onClick={() => void loadMore()}>加载更多</Button>}>
        {page.items.length === 0 ? <EmptyState title="还没有同步计划" description="从会话工作台的“操作”页签生成第一个预览。" /> : <div className="catalog-list">{page.items.map((plan) => <button type="button" key={plan.id} data-selected={selected?.id === plan.id} onClick={() => void props.api.getPlan(plan.id).then(setSelected)}>
          <span><strong>{plan.logicalSessionId}</strong><code>{plan.id}</code></span>
          <Badge tone={statusTone(plan.risk)}>{plan.risk}</Badge>
          <small>{plan.operationCount} 步</small>
        </button>)}</div>}
      </Surface>
      <Surface title="计划详情">
        {selected === undefined ? <EmptyState title="选择一个计划" description="完整操作、风险和确认项会按需显示。" /> : <div className="catalog-detail">
          <div><Badge tone={statusTone(selected.risk)}>{selected.risk}</Badge> <code>{selected.id}</code></div>
          <h3>{selected.operations.length} 个操作</h3>
          <ol>{selected.operations.map((operation, index) => <li key={`${operation.type}-${index}`}><code>{operation.type}</code></li>)}</ol>
          {selected.confirmations.length === 0 ? <p>无需人工确认。</p> : selected.confirmations.map((item) => <p key={item.code}><strong>{item.code}</strong>：{item.message}</p>)}
        </div>}
      </Surface>
    </div>
  </>;
}

export function CheckpointsPage(props: { readonly api: CatalogApi }) {
  const [items, setItems] = useState<readonly Checkpoint[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void props.api.listCheckpoints(controller.signal).then(setItems, (reason: unknown) => setError(reason instanceof Error ? reason.message : "Checkpoint 不可用"));
    return () => controller.abort();
  }, [props.api]);
  if (error !== undefined) return <Surface><EmptyState kind="warning" title="Checkpoint 不可用" description={error} /></Surface>;
  if (items === undefined) return <Surface><LoadingState label="正在读取 Checkpoint…" /></Surface>;
  return <>
    <div className="dsm-page-heading"><div><h2>Checkpoints</h2><p>命名恢复点固定版本引用；新建入口位于对应会话的操作页签。</p></div></div>
    <Surface title={`${items.length} 个 Checkpoint`}>
      {items.length === 0 ? <EmptyState title="还没有 Checkpoint" description="在会话版本树中选择节点后即可建立命名恢复点。" /> : <div className="checkpoint-catalog">{items.map((checkpoint) => <article key={checkpoint.id}>
        <header><strong>{checkpoint.name}</strong><time dateTime={checkpoint.createdAt}>{new Date(checkpoint.createdAt).toLocaleString()}</time></header>
        <MarkdownView>{checkpoint.description}</MarkdownView>
        <code>{Object.entries(checkpoint.refs).map(([name, id]) => `${name} → ${id}`).join("\n")}</code>
      </article>)}</div>}
    </Surface>
  </>;
}
