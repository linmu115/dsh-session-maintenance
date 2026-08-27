import { useEffect, useState } from "react";

import type {
  AdapterDiagnostic,
  IssuedConfirmation,
  JobRef,
  MaintenanceSettings,
  MaintenanceSettingsPatch,
  Page,
  TransactionDetail,
  TransactionQuery,
  TransactionSummary,
} from "@linmu/dsh-session-contracts";
import { Badge, Button, EmptyState, LoadingState, Surface, statusTone } from "@linmu/dsh-session-ui";

export interface OperationsApi {
  listTransactions(query?: TransactionQuery, signal?: AbortSignal): Promise<Page<TransactionSummary>>;
  getTransaction(id: string, signal?: AbortSignal): Promise<TransactionDetail>;
  requestRestoreConfirmation(id: string, signal?: AbortSignal): Promise<IssuedConfirmation>;
  restoreTransaction(id: string, confirmationToken: string, signal?: AbortSignal): Promise<JobRef>;
  requestRecoveryConfirmation(id: string, signal?: AbortSignal): Promise<IssuedConfirmation>;
  recoverTransaction(id: string, confirmationToken: string, signal?: AbortSignal): Promise<JobRef>;
  diagnostics(signal?: AbortSignal): Promise<readonly AdapterDiagnostic[]>;
  getSettings(signal?: AbortSignal): Promise<MaintenanceSettings>;
  patchSettings(input: MaintenanceSettingsPatch, signal?: AbortSignal): Promise<MaintenanceSettings>;
}

function RecoveryPanel(props: { readonly api: OperationsApi; readonly detail: TransactionDetail; readonly onRefresh: () => void }) {
  const [confirmation, setConfirmation] = useState<IssuedConfirmation>();
  const [job, setJob] = useState<JobRef>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { setConfirmation(undefined); setJob(undefined); setError(undefined); }, [props.detail.transaction.id]);
  const decision = props.detail.recovery;
  if (!decision.allowed || decision.action === "none") return <div className="recovery-panel" data-state="blocked"><strong>当前不可自动恢复</strong><p>{decision.reason}</p></div>;
  const issue = async () => {
    setBusy(true); setError(undefined);
    try {
      const next = decision.action === "recover-interrupted"
        ? await props.api.requestRecoveryConfirmation(props.detail.transaction.id)
        : await props.api.requestRestoreConfirmation(props.detail.transaction.id);
      setConfirmation(next);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法创建恢复确认"); }
    finally { setBusy(false); }
  };
  const execute = async () => {
    if (confirmation === undefined) return;
    setBusy(true); setError(undefined);
    try {
      const next = decision.action === "recover-interrupted"
        ? await props.api.recoverTransaction(props.detail.transaction.id, confirmation.token)
        : await props.api.restoreTransaction(props.detail.transaction.id, confirmation.token);
      setJob(next); setConfirmation(undefined); props.onRefresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "恢复作业提交失败"); }
    finally { setBusy(false); }
  };
  return <div className="recovery-panel" data-state="ready">
    <header><div><strong>{decision.action === "recover-interrupted" ? "恢复未完成事务" : "恢复到写入前备份"}</strong><p>{decision.reason}</p></div><Badge tone="warning">需要一次性确认</Badge></header>
    {decision.backupHash === undefined ? null : <p><span>备份</span><code>{decision.backupHash}</code></p>}
    {confirmation === undefined ? <Button disabled={busy || job !== undefined} onClick={() => void issue()}>生成本次恢复确认</Button> : <div className="confirmation-scope">
      <p><span>操作</span><code>{confirmation.operation}</code></p>
      <p><span>事务</span><code>{confirmation.resourceId}</code></p>
      <p><span>作用域哈希</span><code>{confirmation.operationHash}</code></p>
      <p><span>有效期</span><time dateTime={confirmation.expiresAt}>{new Date(confirmation.expiresAt).toLocaleString()}</time></p>
      <Button tone="danger" disabled={busy} onClick={() => void execute()}>确认并提交恢复作业</Button>
    </div>}
    {job === undefined ? null : <p className="job-feedback">已提交作业 <code>{job.id}</code></p>}
    {error === undefined ? null : <p className="inline-error">{error}</p>}
  </div>;
}

export function TransactionsPage(props: { readonly api: OperationsApi }) {
  const [page, setPage] = useState<Page<TransactionSummary>>();
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<TransactionDetail>();
  const [error, setError] = useState<string>();
  const loadList = async (signal?: AbortSignal) => {
    const next = await props.api.listTransactions({ limit: 25 }, signal);
    setPage(next); setSelectedId((current) => current ?? next.items[0]?.id);
  };
  useEffect(() => {
    const controller = new AbortController();
    void loadList(controller.signal).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "事务列表不可用"));
    return () => controller.abort();
  }, [props.api]);
  useEffect(() => {
    if (selectedId === undefined) { setDetail(undefined); return; }
    const controller = new AbortController();
    setDetail(undefined);
    void props.api.getTransaction(selectedId, controller.signal).then(setDetail, (reason: unknown) => setError(reason instanceof Error ? reason.message : "事务详情不可用"));
    return () => controller.abort();
  }, [props.api, selectedId]);
  const loadMore = async () => {
    if (page?.nextCursor === undefined) return;
    const next = await props.api.listTransactions({ cursor: page.nextCursor, limit: 25 });
    setPage({ items: [...page.items, ...next.items], ...(next.nextCursor === undefined ? {} : { nextCursor: next.nextCursor }) });
  };
  if (error !== undefined && page === undefined) return <Surface><EmptyState kind="warning" title="事务与恢复不可用" description={error} /></Surface>;
  if (page === undefined) return <Surface><LoadingState label="正在读取事务摘要…" /></Surface>;
  return <>
    <div className="dsm-page-heading"><div><h2>事务与恢复</h2><p>恢复严格依据 journal、适配器契约和一次性作用域确认；不会提供“忽略错误继续”。</p></div></div>
    <div className="catalog-layout transaction-layout">
      <Surface title={`${page.items.length} 个事务`} action={page.nextCursor === undefined ? null : <Button onClick={() => void loadMore()}>加载更多</Button>}>
        {page.items.length === 0 ? <EmptyState title="还没有写事务" description="安全计划执行后会在这里留下 journal 和验证结果。" /> : <div className="catalog-list">{page.items.map((item) => <button type="button" key={item.id} data-selected={selectedId === item.id} onClick={() => setSelectedId(item.id)}>
          <span><strong>{item.id}</strong><code>{item.planId}</code></span><Badge tone={statusTone(item.status)}>{item.status}</Badge><small>{new Date(item.updatedAt).toLocaleString()}</small>
        </button>)}</div>}
      </Surface>
      <Surface title="事务详情">
        {selectedId !== undefined && detail === undefined ? <LoadingState label="正在读取 journal…" /> : detail === undefined ? <EmptyState title="选择一个事务" description="这里只按需读取完整 journal 与备份摘要。" /> : <div className="transaction-detail">
          <div className="transaction-meta"><Badge tone={statusTone(detail.transaction.status)}>{detail.transaction.status}</Badge><code>{detail.transaction.id}</code>{detail.transaction.errorCode === undefined ? null : <Badge tone="danger">{detail.transaction.errorCode}</Badge>}</div>
          <ol className="transaction-timeline">{detail.steps.map((step) => <li key={step.entryHash}><span>{step.sequence}</span><div><strong>{step.step}</strong><small>{new Date(step.at).toLocaleString()}</small><code>{step.entryHash}</code></div><Badge tone={statusTone(step.status)}>{step.status}</Badge></li>)}</ol>
          <RecoveryPanel api={props.api} detail={detail} onRefresh={() => void props.api.getTransaction(detail.transaction.id).then(setDetail)} />
        </div>}
      </Surface>
    </div>
  </>;
}

export function DiagnosticsPage(props: { readonly api: OperationsApi }) {
  const [items, setItems] = useState<readonly AdapterDiagnostic[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void props.api.diagnostics(controller.signal).then(setItems, (reason: unknown) => setError(reason instanceof Error ? reason.message : "适配器诊断不可用"));
    return () => controller.abort();
  }, [props.api]);
  if (error !== undefined) return <Surface><EmptyState kind="warning" title="适配器诊断不可用" description={error} /></Surface>;
  if (items === undefined) return <Surface><LoadingState label="正在探测版本契约…" /></Surface>;
  return <><div className="dsm-page-heading"><div><h2>适配器诊断</h2><p>只显示登记 ID、版本契约和能力；不会把本机文件路径发送到浏览器。</p></div></div><div className="diagnostic-grid">{items.map((item) => <Surface key={item.instance.id} title={item.instance.displayName} action={<Badge tone={statusTone(item.writeStatus)}>{item.writeStatus}</Badge>}><div className="diagnostic-card">
    <p><span>实例</span><code>{item.instance.id}</code></p><p><span>读取契约</span><code>{item.readContract.adapter} · {item.readContract.platformVersion} · {item.readContract.schemaFingerprint}</code></p><p><span>写入契约</span><code>{item.writeContract === undefined ? "未连接" : `${item.writeContract.adapter} · ${item.writeContract.platformVersion} · ${item.writeContract.schemaFingerprint}`}</code></p>
    <div className="capability-list">{item.writeCapabilities.length === 0 ? <Badge>无写能力</Badge> : item.writeCapabilities.map((capability) => <Badge key={capability}>{capability}</Badge>)}</div>
    {item.issues.length === 0 ? <p className="diagnostic-ok">未发现契约问题。</p> : <ul>{item.issues.map((issue) => <li key={`${issue.code}-${issue.message}`}><strong>{issue.code}</strong>：{issue.message}</li>)}</ul>}
  </div></Surface>)}</div></>;
}

export function SettingsPage(props: { readonly api: OperationsApi }) {
  const [value, setValue] = useState<MaintenanceSettings>();
  const [draft, setDraft] = useState<MaintenanceSettings>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void props.api.getSettings(controller.signal).then((next) => { setValue(next); setDraft(next); }, (reason: unknown) => setError(reason instanceof Error ? reason.message : "设置不可用"));
    return () => controller.abort();
  }, [props.api]);
  if (error !== undefined && draft === undefined) return <Surface><EmptyState kind="warning" title="设置不可用" description={error} /></Surface>;
  if (draft === undefined) return <Surface><LoadingState label="正在读取设置…" /></Surface>;
  const set = <K extends keyof MaintenanceSettings>(key: K, next: MaintenanceSettings[K]) => setDraft({ ...draft, [key]: next });
  const save = async () => {
    setError(undefined); setMessage(undefined);
    try { const next = await props.api.patchSettings(draft); setValue(next); setDraft(next); setMessage("设置已保存"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "设置保存失败"); }
  };
  return <><div className="dsm-page-heading"><div><h2>设置</h2><p>这里只登记平台和工作区 ID；路径发现与格式知识仍封装在 Engine。</p></div></div><Surface title="同步策略" action={<Button tone="primary" disabled={JSON.stringify(value) === JSON.stringify(draft)} onClick={() => void save()}>保存设置</Button>}><div className="settings-form">
    <label className="field"><span>Codex 实例 ID</span><input value={draft.codexInstanceId ?? ""} onChange={(event) => set("codexInstanceId", event.target.value || null)} /></label>
    <label className="field"><span>DSH 实例 ID</span><input value={draft.dshInstanceId ?? ""} onChange={(event) => set("dshInstanceId", event.target.value || null)} /></label>
    <label className="field"><span>工作区映射 ID</span><input value={draft.workspaceMappingId ?? ""} onChange={(event) => set("workspaceMappingId", event.target.value || null)} /></label>
    <label className="field"><span>扫描范围</span><select value={draft.scanScope} onChange={(event) => set("scanScope", event.target.value as MaintenanceSettings["scanScope"])}><option value="current">当前登记</option><option value="registered">全部登记实例</option></select></label>
    <label className="field"><span>备份保留事务数</span><input type="number" min={1} max={10_000} value={draft.backupRetention} onChange={(event) => set("backupRetention", Number(event.target.value))} /></label>
    <label className="toggle-field"><input type="checkbox" checked={draft.syncSingleSidedTitle} onChange={(event) => set("syncSingleSidedTitle", event.target.checked)} /><span>同步单边标题变化</span></label>
    <label className="toggle-field"><input type="checkbox" checked={draft.syncArchive} onChange={(event) => set("syncArchive", event.target.checked)} /><span>双向同步归档状态</span></label>
    <label className="toggle-field"><input type="checkbox" checked={draft.allowBatchSafeApply} onChange={(event) => set("allowBatchSafeApply", event.target.checked)} /><span>允许批量应用安全计划</span></label>
    {message === undefined ? null : <p className="job-feedback">{message}</p>}{error === undefined ? null : <p className="inline-error">{error}</p>}
  </div></Surface></>;
}
