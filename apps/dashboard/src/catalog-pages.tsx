import { useEffect, useState } from "react";

import type { Checkpoint, CheckpointRestoreRequest, DashboardOverview, Page, PlanQuery, PlanSummary, SyncPlan } from "@linmu/dsh-session-contracts";
import { Badge, Button, EmptyState, LoadingState, Surface, statusTone } from "@linmu/dsh-session-ui";
import { MarkdownView } from "@linmu/dsh-session-ui/markdown";

export interface CatalogApi {
  listPlans(query?: PlanQuery, signal?: AbortSignal): Promise<Page<PlanSummary>>;
  getPlan(id: string, signal?: AbortSignal): Promise<SyncPlan>;
  listCheckpoints(signal?: AbortSignal): Promise<readonly Checkpoint[]>;
  overview(signal?: AbortSignal): Promise<DashboardOverview>;
  createCheckpointRestorePlan(input: CheckpointRestoreRequest, signal?: AbortSignal): Promise<SyncPlan>;
}

export interface CheckpointRestorePreview {
  readonly key: string;
  readonly plan: SyncPlan;
}

export async function requestCheckpointRestorePreview(
  api: Pick<CatalogApi, "createCheckpointRestorePlan">,
  input: CheckpointRestoreRequest,
  current?: CheckpointRestorePreview,
): Promise<CheckpointRestorePreview> {
  const key = `${input.checkpointId}\0${input.targetInstanceId}`;
  if (current?.key === key) return current;
  return { key, plan: await api.createCheckpointRestorePlan(input) };
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
  const [overview, setOverview] = useState<DashboardOverview>();
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [targetId, setTargetId] = useState<string>();
  const [preview, setPreview] = useState<CheckpointRestorePreview>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([props.api.listCheckpoints(controller.signal), props.api.overview(controller.signal)]).then(
      ([nextItems, nextOverview]) => {
        setItems(nextItems); setOverview(nextOverview);
        setSelectedId((current) => current ?? nextItems[0]?.id);
        setTargetId((current) => current ?? nextOverview.instances.find((item) => item.platform === "dsh")?.id);
      },
      (reason: unknown) => setError(reason instanceof Error ? reason.message : "Checkpoint 不可用"),
    );
    return () => controller.abort();
  }, [props.api]);
  const createPreview = async () => {
    if (selectedId === undefined || targetId === undefined || busy) return;
    setBusy(true); setActionError(undefined);
    try {
      setPreview(await requestCheckpointRestorePreview(props.api, {
        checkpointId: selectedId,
        targetInstanceId: targetId,
        createdAt: new Date().toISOString(),
      }, preview));
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "无法生成恢复计划");
    } finally { setBusy(false); }
  };
  if (error !== undefined) return <Surface><EmptyState kind="warning" title="Checkpoint 不可用" description={error} /></Surface>;
  if (items === undefined || overview === undefined) return <Surface><LoadingState label="正在读取 Checkpoint…" /></Surface>;
  const dshInstances = overview.instances.filter((instance) => instance.platform === "dsh");
  const previewKey = selectedId === undefined || targetId === undefined ? undefined : `${selectedId}\0${targetId}`;
  const currentPreview = preview?.key === previewKey ? preview : undefined;
  return <>
    <div className="dsm-page-heading"><div><h2>Checkpoints</h2><p>建立 Checkpoint 与恢复是两件事；恢复先生成可审查计划，不直接覆盖当前会话。</p></div></div>
    <div className="catalog-layout">
      <Surface title={`${items.length} 个 Checkpoint`}>
        {items.length === 0 ? <EmptyState title="还没有 Checkpoint" description="在会话版本树中选择节点后即可建立命名恢复点。" /> : <div className="checkpoint-catalog checkpoint-picker">{items.map((checkpoint) => <button type="button" data-selected={selectedId === checkpoint.id} onClick={() => { setSelectedId(checkpoint.id); setPreview(undefined); }} key={checkpoint.id}>
          <header><strong>{checkpoint.name}</strong><time dateTime={checkpoint.createdAt}>{new Date(checkpoint.createdAt).toLocaleString()}</time></header>
          <MarkdownView>{checkpoint.description}</MarkdownView>
          <code>{Object.entries(checkpoint.refs).map(([name, id]) => `${name} → ${id}`).join("\n")}</code>
        </button>)}</div>}
      </Surface>
      <Surface title="恢复计划预览">
        <div className="catalog-detail">
          <p>恢复会从所选版本新建一个 DSH 会话分支；当前 DSH 分支和之后的版本都保留。</p>
          <label className="field"><span>目标 DSH 实例</span><select value={targetId ?? ""} onChange={(event) => { setTargetId(event.target.value || undefined); setPreview(undefined); }}>
            <option value="">请选择</option>{dshInstances.map((instance) => <option key={instance.id} value={instance.id}>{instance.displayName} · {instance.id}</option>)}
          </select></label>
          <Button tone="primary" disabled={busy || selectedId === undefined || targetId === undefined || currentPreview !== undefined} onClick={() => void createPreview()}>{busy ? "正在生成…" : currentPreview !== undefined ? "已生成当前预览" : "生成恢复计划预览"}</Button>
          {dshInstances.length === 0 ? <p className="muted">尚未登记 DSH 实例，不能生成预览。</p> : null}
          {actionError === undefined ? null : <p className="inline-error">{actionError}</p>}
          {currentPreview === undefined ? null : <div className="restore-plan-preview"><div><Badge tone={statusTone(currentPreview.plan.risk)}>{currentPreview.plan.risk}</Badge><code>{currentPreview.plan.id}</code></div><ol>{currentPreview.plan.operations.map((operation, index) => <li key={`${operation.type}-${index}`}><code>{operation.type}</code></li>)}</ol><p>这里只建立不可变计划；不会自动应用、重置或删除任何现有分支。</p></div>}
        </div>
      </Surface>
    </div>
  </>;
}
