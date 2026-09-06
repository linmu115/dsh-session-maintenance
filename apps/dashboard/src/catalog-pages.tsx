import { useEffect, useRef, useState } from "react";

import type { Checkpoint, CheckpointRestoreCapability, CheckpointRestoreRequest, DashboardOverview, Page, PlanQuery, PlanSummary, SyncPlan } from "@linmu/dsh-session-contracts";
import { Badge, Button, EmptyState, LoadingState, Surface, statusTone } from "@linmu/dsh-session-ui";
import { MarkdownView } from "@linmu/dsh-session-ui/markdown";

export interface CatalogApi {
  listPlans(query?: PlanQuery, signal?: AbortSignal): Promise<Page<PlanSummary>>;
  getPlan(id: string, signal?: AbortSignal): Promise<SyncPlan>;
  listCheckpoints(signal?: AbortSignal): Promise<readonly Checkpoint[]>;
  overview(signal?: AbortSignal): Promise<DashboardOverview>;
  createCheckpointRestorePlan(input: CheckpointRestoreRequest, signal?: AbortSignal): Promise<SyncPlan>;
  getCheckpointRestoreCapability?(checkpointId: string, signal?: AbortSignal): Promise<CheckpointRestoreCapability>;
}

export interface CheckpointRestorePreview {
  readonly key: string;
  readonly plan: SyncPlan;
}

export async function requestCheckpointRestorePreview(
  api: Pick<CatalogApi, "createCheckpointRestorePlan">,
  input: CheckpointRestoreRequest,
  current?: CheckpointRestorePreview,
  signal?: AbortSignal,
): Promise<CheckpointRestorePreview> {
  const key = `${input.checkpointId}\0${input.targetInstanceId}`;
  if (current?.key === key) return current;
  return { key, plan: await api.createCheckpointRestorePlan(input, signal) };
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
    <div className="dsm-page-heading"><div><h2>同步计划</h2><p>查看过去生成的操作预览、风险和确认项。</p></div></div>
    <div className="catalog-layout">
      <Surface title={`${page.items.length} 个计划`} action={page.nextCursor === undefined ? null : <Button onClick={() => void loadMore()}>加载更多</Button>}>
        {page.items.length === 0 ? <EmptyState title="还没有同步计划" description="生成的同步预览会保留在这里。" /> : <div className="catalog-list">{page.items.map((plan) => <button type="button" key={plan.id} data-selected={selected?.id === plan.id} onClick={() => void props.api.getPlan(plan.id).then(setSelected)}>
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
  const [capability, setCapability] = useState<CheckpointRestoreCapability>();
  const [capabilityError, setCapabilityError] = useState<string>();
  const [capabilityRetry, setCapabilityRetry] = useState(0);
  const lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void Promise.all([props.api.listCheckpoints(controller.signal), props.api.overview(controller.signal)]).then(
      ([nextItems, nextOverview]) => {
        if (controller.signal.aborted) return;
        setItems(nextItems); setOverview(nextOverview);
        setSelectedId((current) => current ?? nextItems[0]?.id);
        setTargetId((current) => current ?? nextOverview.instances.find((item) => item.platform === "dsh")?.id);
      },
      (reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "恢复点不可用"); },
    );
    return () => controller.abort();
  }, [props.api]);
  useEffect(() => {
    const controller = new AbortController();
    setCapability(undefined); setCapabilityError(undefined); setPreview(undefined);
    if (selectedId !== undefined) {
      if (props.api.getCheckpointRestoreCapability === undefined) {
        setCapabilityError("当前引擎未提供恢复来源核验，暂不能生成旧版本恢复预览。");
      } else void props.api.getCheckpointRestoreCapability(selectedId, controller.signal).then((value) => {
        if (!controller.signal.aborted) {
          if (value.checkpointId === selectedId) setCapability(value);
          else setCapabilityError("恢复来源核验与当前选择不一致，请重新核验。");
        }
      }, (reason: unknown) => {
        if (!controller.signal.aborted) setCapabilityError(`无法核验恢复来源：${reason instanceof Error ? reason.message : "请稍后重试"}`);
      });
    }
    return () => controller.abort();
  }, [props.api, selectedId, capabilityRetry]);
  const sourceSupported = capability?.checkpointId === selectedId && capability?.supported === true;
  const createPreview = async () => {
    if (selectedId === undefined || targetId === undefined || busy || !sourceSupported) return;
    const signal = lifetime.current?.signal;
    setBusy(true); setActionError(undefined);
    try {
      const result = await requestCheckpointRestorePreview(props.api, {
        checkpointId: selectedId,
        targetInstanceId: targetId,
        createdAt: new Date().toISOString(),
      }, preview, signal);
      if (!signal?.aborted) setPreview(result);
    } catch (reason) {
      if (!signal?.aborted) setActionError(reason instanceof Error ? reason.message : "无法生成恢复计划");
    } finally { if (!signal?.aborted) setBusy(false); }
  };
  if (error !== undefined) return <Surface><EmptyState kind="warning" title="恢复点不可用" description={error} /></Surface>;
  if (items === undefined || overview === undefined) return <Surface><LoadingState label="正在读取恢复点…" /></Surface>;
  const dshInstances = overview.instances.filter((instance) => instance.platform === "dsh");
  const previewKey = selectedId === undefined || targetId === undefined ? undefined : `${selectedId}\0${targetId}`;
  const currentPreview = sourceSupported && preview?.key === previewKey ? preview : undefined;
  return <>
    <div className="dsm-page-heading"><div><h2>已有保护记录</h2><p>恢复点保存选定会话版本的引用与说明。删除前的自动保护记录用于保留依据，撤销删除请使用上方“最近删除”；当前会话的任意历史版本还原尚未提供。</p></div></div>
    <div className="catalog-layout">
      <Surface title={`${items.length} 个恢复点`}>
        {items.length === 0 ? <EmptyState title="还没有恢复点" description="已有恢复点会显示在这里，记录保存时间、说明和所指向的版本。" /> : <div className="checkpoint-catalog checkpoint-picker">{items.map((checkpoint) => <button type="button" data-selected={selectedId === checkpoint.id} onClick={() => { setSelectedId(checkpoint.id); setPreview(undefined); }} key={checkpoint.id}>
          <header><strong>{checkpoint.name}</strong><time dateTime={checkpoint.createdAt}>{new Date(checkpoint.createdAt).toLocaleString()}</time></header>
          <MarkdownView>{checkpoint.description}</MarkdownView>
          <p>保存了 {Object.keys(checkpoint.refs).length} 个版本引用</p>
        </button>)}</div>}
      </Surface>
      <Surface title="旧版本恢复预览">
        <div className="catalog-detail">
          <p>仅适用于经过支持性核验的旧版会话记录。支持时会从所选版本新建一个 DSH 会话分支；当前 DSH 分支和之后的版本都保留。</p><p>选定目标后仍需生成预览并检查影响与确认项。生成预览不会执行恢复。</p><details><summary>保存的版本引用</summary><pre>{Object.entries(items.find((item) => item.id === selectedId)?.refs ?? {}).map(([name, id]) => `${name} → ${id}`).join("\n")}</pre></details>
          {selectedId === undefined ? <p className="muted">选择一条保护记录后，会核验它是否支持旧版恢复预览。</p> : capabilityError !== undefined ? <p role="alert" className="inline-error">{capabilityError}</p> : capability?.checkpointId !== selectedId ? <LoadingState label="正在核验恢复来源…" /> : <p role="status"><Badge tone={sourceSupported ? "success" : "warning"}>{sourceSupported ? "来源支持旧版预览" : "不支持旧版预览"}</Badge> {capability.reason}</p>}
          {selectedId !== undefined && props.api.getCheckpointRestoreCapability !== undefined ? <Button disabled={busy} onClick={() => setCapabilityRetry((value) => value + 1)}>重新核验恢复来源</Button> : null}
          <p className="muted">来源核验不代表目标实例可写；目标能力仍由生成预览时检查。</p>
          <label className="field"><span>目标 DSH 实例</span><select value={targetId ?? ""} onChange={(event) => { setTargetId(event.target.value || undefined); setPreview(undefined); }}>
            <option value="">请选择</option>{dshInstances.map((instance) => <option key={instance.id} value={instance.id}>{instance.displayName} · {instance.id}</option>)}
          </select></label>
          <Button tone="primary" disabled={busy || !sourceSupported || selectedId === undefined || targetId === undefined || currentPreview !== undefined} onClick={() => void createPreview()}>{busy ? "正在生成…" : currentPreview !== undefined ? "已生成当前预览" : "生成恢复计划预览"}</Button>
          {dshInstances.length === 0 ? <p className="muted">尚未登记 DSH 实例，不能生成预览。</p> : null}
          {actionError === undefined ? null : <p role="alert" className="inline-error">{actionError}</p>}
          {currentPreview === undefined ? null : <div className="restore-plan-preview"><div><Badge tone={statusTone(currentPreview.plan.risk)}>{currentPreview.plan.risk}</Badge><code>{currentPreview.plan.id}</code></div><ol>{currentPreview.plan.operations.map((operation, index) => <li key={`${operation.type}-${index}`}><code>{operation.type}</code></li>)}</ol>{currentPreview.plan.confirmations.map((confirmation) => <p key={confirmation.code}><strong>需要确认：</strong>{confirmation.message}</p>)}<p>这里只建立不可变计划；不会自动应用、重置或删除任何现有分支。</p></div>}
        </div>
      </Surface>
    </div>
  </>;
}
