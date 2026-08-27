import { useEffect, useMemo, useState } from "react";

import type {
  Checkpoint,
  CheckpointRestoreRequest,
  CreateCheckpointRequest,
  JobRef,
  NativeMirrorActionRequest,
  NativeMirrorRecord,
  PlanRequest,
  PlanQuery,
  PlanSummary,
  Page,
  SessionDetail,
  SessionDiff,
  SyncPlan,
  VersionContent,
  VersionGraphPage,
} from "@linmu/dsh-session-contracts";
import {
  Badge,
  Button,
  EmptyState,
  GitGraphCanvas,
  LoadingState,
  LocalTabs,
  Surface,
  statusTone,
  type GitGraphNode,
} from "@linmu/dsh-session-ui";
import { MarkdownView } from "@linmu/dsh-session-ui/markdown";

import type { DashboardSummaryApi } from "./summary-loader.js";

export interface WorkbenchApi extends DashboardSummaryApi {
  getSession(id: string, signal?: AbortSignal): Promise<SessionDetail>;
  getGraph(id: string, cursor?: string, signal?: AbortSignal): Promise<VersionGraphPage>;
  getVersion(id: string, versionId: string, signal?: AbortSignal): Promise<VersionContent>;
  getDiff(input: { readonly logicalSessionId: string; readonly sourceBindingId?: string; readonly targetBindingId?: string }, signal?: AbortSignal): Promise<SessionDiff>;
  createPlan(input: PlanRequest, signal?: AbortSignal): Promise<SyncPlan>;
  applyPlan(id: string, signal?: AbortSignal): Promise<JobRef>;
  listCheckpoints(signal?: AbortSignal): Promise<readonly Checkpoint[]>;
  createCheckpoint(input: CreateCheckpointRequest, signal?: AbortSignal): Promise<Checkpoint>;
  listPlans(query?: PlanQuery, signal?: AbortSignal): Promise<Page<PlanSummary>>;
  getPlan(id: string, signal?: AbortSignal): Promise<SyncPlan>;
  createCheckpointRestorePlan(input: CheckpointRestoreRequest, signal?: AbortSignal): Promise<SyncPlan>;
  getNativeMirror(id: string, signal?: AbortSignal): Promise<NativeMirrorRecord | undefined>;
  applyNativeMirrorAction(id: string, input: NativeMirrorActionRequest, signal?: AbortSignal): Promise<NativeMirrorRecord>;
}

export interface WorkbenchInitial {
  readonly detail: SessionDetail;
  readonly graph: VersionGraphPage;
  readonly checkpoints: readonly Checkpoint[];
  readonly mirror?: NativeMirrorRecord;
}

export async function loadWorkbenchInitial(api: WorkbenchApi, logicalSessionId: string, signal?: AbortSignal): Promise<WorkbenchInitial> {
  const [detail, graph, checkpoints, mirror] = await Promise.all([
    api.getSession(logicalSessionId, signal),
    api.getGraph(logicalSessionId, undefined, signal),
    api.listCheckpoints(signal),
    api.getNativeMirror(logicalSessionId, signal),
  ]);
  return { detail, graph, checkpoints, ...(mirror === undefined ? {} : { mirror }) };
}

export function planApplyState(plan: SyncPlan | undefined): { readonly allowed: boolean; readonly reason: string } {
  if (plan === undefined) return { allowed: false, reason: "请先生成计划预览" };
  if (plan.risk !== "safe") return { allowed: false, reason: `风险级别为 ${plan.risk}，必须进入人工处理` };
  if (plan.confirmations.length > 0 || plan.operations.some((operation) => operation.type === "require-review")) {
    return { allowed: false, reason: "计划包含人工确认或冲突步骤" };
  }
  return { allowed: true, reason: "该计划通过安全快进门禁" };
}

type Tab = "overview" | "content" | "diff" | "operations";
type Loadable<T> =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly value: T };

function VersionBody(props: { readonly state: Loadable<VersionContent> }) {
  if (props.state.kind === "idle") return <EmptyState title="选择一个版本" description="点击左侧版本节点后才会读取正文。" />;
  if (props.state.kind === "loading") return <LoadingState label="正在读取所选版本…" />;
  if (props.state.kind === "error") return <EmptyState kind="warning" title="版本正文不可用" description={props.state.message} />;
  return <div className="version-body">
    <div className="version-meta">
      <Badge>{props.state.value.session.key.platform}</Badge>
      <code>{props.state.value.manifest.id}</code>
      <span>{props.state.value.session.events.length} 个事件</span>
    </div>
    {props.state.value.session.events.map((event) => <article className="event-card" key={event.id}>
      <header><Badge>{event.role}</Badge><code>#{event.sequence}</code><span>{event.kind}</span></header>
      <MarkdownView>{event.content}</MarkdownView>
    </article>)}
  </div>;
}

interface DiffBundle {
  readonly diff: SessionDiff;
  readonly source?: VersionContent;
  readonly base?: VersionContent;
  readonly target?: VersionContent;
}

function ThreeWayDiff(props: { readonly state: Loadable<DiffBundle>; readonly onLoad: () => void }) {
  if (props.state.kind === "idle") return <EmptyState title="三方差异尚未读取" description="只在点击比较后读取两侧 head 与共同基线。" action={<Button onClick={props.onLoad}>比较两侧版本</Button>} />;
  if (props.state.kind === "loading") return <LoadingState label="正在计算三方差异…" />;
  if (props.state.kind === "error") return <EmptyState kind="warning" title="无法比较" description={props.state.message} action={<Button onClick={props.onLoad}>重试</Button>} />;
  const column = (title: string, value: VersionContent | undefined) => <section className="diff-column">
    <h3>{title}</h3>
    {value === undefined ? <p>无可证明版本</p> : <>
      <code>{value.manifest.id}</code>
      <strong>{value.session.events.length} 个事件</strong>
      <span>{value.session.title}</span>
    </>}
  </section>;
  return <div className="three-way-diff">
    <div className="diff-summary">
      <Badge tone={statusTone(props.state.value.diff.relation)}>{props.state.value.diff.relation}</Badge>
      <span>对话：{props.state.value.diff.conversation}</span>
      <span>元数据：{props.state.value.diff.metadata}</span>
    </div>
    <div className="diff-columns">
      {column("来源", props.state.value.source)}
      {column("共同基线", props.state.value.base)}
      {column("目标", props.state.value.target)}
    </div>
  </div>;
}

function PlanPreview(props: {
  readonly plan: SyncPlan | undefined;
  readonly busy: boolean;
  readonly job: JobRef | undefined;
  readonly onPreview: () => void;
  readonly onApply: () => void;
}) {
  const state = planApplyState(props.plan);
  return <div className="operation-block">
    <header><div><h3>同步计划</h3><p>预览不会写入平台；只有 safe 计划可从此处应用。</p></div><Button onClick={props.onPreview} disabled={props.busy}>生成预览</Button></header>
    {props.plan === undefined ? <p className="muted">尚未生成计划。</p> : <>
      <div className="plan-summary"><Badge tone={statusTone(props.plan.risk)}>{props.plan.risk}</Badge><code>{props.plan.id}</code><span>{props.plan.operations.length} 个步骤</span></div>
      <ol className="operation-list">{props.plan.operations.map((operation, index) => <li key={`${operation.type}-${index}`}><code>{operation.type}</code></li>)}</ol>
      <div className="risk-gate"><span>{state.reason}</span><Button tone="primary" disabled={!state.allowed || props.busy} onClick={props.onApply}>应用安全计划</Button></div>
      {props.job === undefined ? null : <p className="job-feedback">已提交作业 <code>{props.job.id}</code></p>}
    </>}
  </div>;
}

function CheckpointEditor(props: {
  readonly versionId: string | undefined;
  readonly logicalSessionId: string;
  readonly checkpoints: readonly Checkpoint[];
  readonly onCreate: (input: CreateCheckpointRequest) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (props.versionId === undefined || name.trim().length === 0) return;
    setBusy(true);
    try {
      await props.onCreate({
        name: name.trim(),
        description,
        refs: { [`session:${props.logicalSessionId}`]: props.versionId },
        backupTransactionIds: [],
        createdBy: "dashboard-user",
        createdAt: new Date().toISOString(),
      });
      setName(""); setDescription("");
    } finally { setBusy(false); }
  };
  return <div className="operation-block">
    <header><div><h3>命名 Checkpoint</h3><p>固定所选版本引用，不复制会话正文。</p></div></header>
    <label className="field"><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label className="field"><span>说明（Markdown）</span><textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
    <div className="checkpoint-actions"><code>{props.versionId ?? "请先选择版本"}</code><Button disabled={busy || props.versionId === undefined || name.trim().length === 0} onClick={() => void submit()}>建立 Checkpoint</Button></div>
    <div className="checkpoint-list">{props.checkpoints.map((checkpoint) => <article key={checkpoint.id}><strong>{checkpoint.name}</strong><MarkdownView>{checkpoint.description}</MarkdownView><code>{checkpoint.id}</code></article>)}</div>
  </div>;
}

function NativeMirrorPanel(props: {
  readonly mirror: NativeMirrorRecord | undefined;
  readonly busy: boolean;
  readonly onAction: (input: NativeMirrorActionRequest) => void;
}) {
  const state = props.mirror?.state ?? "disabled";
  return <div className="operation-block mirror-panel">
    <header><div><h3>Codex 原生双向镜像</h3><p>只对这个会话启用；普通会话仍使用 continuation。两侧分叉时绝不自动覆盖。</p></div><Badge tone={statusTone(state)}>{state}</Badge></header>
    {props.mirror === undefined
      ? <Button tone="primary" disabled={props.busy} onClick={() => props.onAction({ action: "enable" })}>启用此会话镜像</Button>
      : <>
        <div className="mirror-heads"><span>共同版本 <code>{props.mirror.commonVersionId ?? "无"}</code></span><span>Codex <code>{props.mirror.codexVersionId ?? "无"}</code></span><span>DSH <code>{props.mirror.dshVersionId ?? "无"}</code></span></div>
        {props.mirror.pauseReason === null ? null : <p className="muted">{props.mirror.pauseReason}</p>}
        <div className="mirror-actions">
          {state === "paused" ? <Button disabled={props.busy} onClick={() => props.onAction({ action: "resume" })}>恢复镜像</Button> : <Button disabled={props.busy} onClick={() => props.onAction({ action: "pause" })}>暂停镜像</Button>}
          {state === "conflicted" ? <>
            <Button disabled={props.busy} onClick={() => props.onAction({ action: "keep-branches" })}>保留两个分支</Button>
            <Button disabled={props.busy} onClick={() => props.onAction({ action: "choose-canonical", platform: "codex" })}>Codex 设为主线</Button>
            <Button disabled={props.busy} onClick={() => props.onAction({ action: "choose-canonical", platform: "dsh" })}>DSH 设为主线</Button>
          </> : null}
          <Button disabled={props.busy} onClick={() => props.onAction({ action: "unlink" })}>解除映射</Button>
        </div>
        <p className="muted">历史重置与会话删除在平台没有可恢复写入契约前保持禁用，不会用修改索引冒充成功。</p>
      </>}
  </div>;
}

export function SessionWorkbench(props: { readonly api: WorkbenchApi; readonly logicalSessionId: string }) {
  const [initial, setInitial] = useState<Exclude<Loadable<WorkbenchInitial>, { readonly kind: "idle" }>>({ kind: "loading" });
  const [tab, setTab] = useState<Tab>("overview");
  const [selectedId, setSelectedId] = useState<string>();
  const [version, setVersion] = useState<Loadable<VersionContent>>({ kind: "idle" });
  const [diff, setDiff] = useState<Loadable<DiffBundle>>({ kind: "idle" });
  const [plan, setPlan] = useState<SyncPlan>();
  const [job, setJob] = useState<JobRef>();
  const [busy, setBusy] = useState(false);
  const [mirror, setMirror] = useState<NativeMirrorRecord>();

  useEffect(() => {
    const controller = new AbortController();
    setInitial({ kind: "loading" });
    void loadWorkbenchInitial(props.api, props.logicalSessionId, controller.signal).then(
      (value) => { setInitial({ kind: "ready", value }); setMirror(value.mirror); },
      (error: unknown) => { if (!controller.signal.aborted) setInitial({ kind: "error", message: error instanceof Error ? error.message : "会话工作台不可用" }); },
    );
    return () => controller.abort();
  }, [props.api, props.logicalSessionId]);

  const selectVersion = (id: string) => {
    setSelectedId(id); setTab("content"); setVersion({ kind: "loading" });
    void props.api.getVersion(props.logicalSessionId, id).then(
      (value) => setVersion({ kind: "ready", value }),
      (error: unknown) => setVersion({ kind: "error", message: error instanceof Error ? error.message : "版本正文不可用" }),
    );
  };

  const ready = initial.kind === "ready" ? initial.value : undefined;
  const bindings = ready?.detail.bindings ?? [];
  const sourceId = bindings[0]?.id;
  const targetId = bindings[1]?.id;
  const headVersion = (bindingId: string | undefined) => ready?.detail.heads.find((head) => head.bindingId === bindingId)?.versionId;
  const loadDiff = async () => {
    if (ready === undefined || sourceId === undefined || targetId === undefined) return;
    setDiff({ kind: "loading" });
    try {
      const result = await props.api.getDiff({ logicalSessionId: props.logicalSessionId, sourceBindingId: sourceId, targetBindingId: targetId });
      const sourceVersionId = headVersion(sourceId);
      const targetVersionId = headVersion(targetId);
      const [source, base, target] = await Promise.all([
        sourceVersionId === undefined ? undefined : props.api.getVersion(props.logicalSessionId, sourceVersionId),
        result.mergeBase === undefined ? undefined : props.api.getVersion(props.logicalSessionId, result.mergeBase),
        targetVersionId === undefined ? undefined : props.api.getVersion(props.logicalSessionId, targetVersionId),
      ]);
      setDiff({ kind: "ready", value: {
        diff: result,
        ...(source === undefined ? {} : { source }),
        ...(base === undefined ? {} : { base }),
        ...(target === undefined ? {} : { target }),
      } });
    } catch (error) { setDiff({ kind: "error", message: error instanceof Error ? error.message : "三方差异不可用" }); }
  };
  const previewPlan = async () => {
    if (sourceId === undefined) return;
    setBusy(true);
    try { setPlan(await props.api.createPlan({ logicalSessionId: props.logicalSessionId, sourceBindingId: sourceId, ...(targetId === undefined ? {} : { targetBindingId: targetId }), createdAt: new Date().toISOString() })); }
    finally { setBusy(false); }
  };
  const createCheckpoint = async (input: CreateCheckpointRequest) => {
    const checkpoint = await props.api.createCheckpoint(input);
    if (initial.kind === "ready") setInitial({ kind: "ready", value: { ...initial.value, checkpoints: [...initial.value.checkpoints, checkpoint] } });
  };
  const mirrorAction = async (input: NativeMirrorActionRequest) => {
    setBusy(true);
    try {
      const next = await props.api.applyNativeMirrorAction(props.logicalSessionId, input);
      setMirror(next.state === "disabled" ? undefined : next);
    } finally { setBusy(false); }
  };
  const loadMoreGraph = async () => {
    if (initial.kind !== "ready" || initial.value.graph.nextCursor === undefined) return;
    const next = await props.api.getGraph(props.logicalSessionId, initial.value.graph.nextCursor);
    setInitial({ kind: "ready", value: {
      ...initial.value,
      graph: {
        nodes: [...initial.value.graph.nodes, ...next.nodes],
        refs: next.refs.length === 0 ? initial.value.graph.refs : next.refs,
        ...(next.nextCursor === undefined ? {} : { nextCursor: next.nextCursor }),
      },
    } });
  };
  const graphNodes: readonly GitGraphNode[] = useMemo(() => (ready?.graph.nodes ?? []).map((node) => ({ id: node.id, parents: node.parents, observedAt: node.source.observedAt, label: node.source.platform })), [ready]);
  const graphRefs = Object.fromEntries((ready?.graph.refs ?? []).map((ref) => [ref.name, ref.versionId]));

  if (initial.kind === "loading") return <Surface><LoadingState label="正在读取会话版本摘要…" /></Surface>;
  if (initial.kind === "error") return <Surface><EmptyState kind="warning" title="会话工作台不可用" description={initial.message} /></Surface>;
  return <div className="version-workbench">
    <aside className="version-graph-pane">
      <header><strong>版本树</strong><span className="graph-header-actions"><Badge>{initial.value.graph.nodes.length}</Badge>{initial.value.graph.nextCursor === undefined ? null : <button type="button" onClick={() => void loadMoreGraph()}>更多</button>}</span></header>
      <GitGraphCanvas nodes={graphNodes} {...(selectedId === undefined ? {} : { selectedId })} refs={graphRefs} onSelect={selectVersion} />
    </aside>
    <Surface>
      <LocalTabs value={tab} onChange={(value) => setTab(value as Tab)} tabs={[
        { id: "overview", label: "介绍" },
        { id: "content", label: "版本内容" },
        { id: "diff", label: "三方差异" },
        { id: "operations", label: "操作" },
      ]} />
      <div className="workbench-content">
        {tab === "overview" ? <div className="session-overview">
          <h2>{initial.value.detail.summary.title}</h2>
          <p>逻辑会话 <code>{props.logicalSessionId}</code></p>
          <div className="binding-list">{initial.value.detail.bindings.map((binding) => <article key={binding.id}><Badge>{binding.key.platform}</Badge><strong>{binding.key.sessionId}</strong><code>{binding.id}</code></article>)}</div>
        </div> : null}
        {tab === "content" ? <VersionBody state={version} /> : null}
        {tab === "diff" ? <ThreeWayDiff state={diff} onLoad={() => void loadDiff()} /> : null}
        {tab === "operations" ? <>
          <NativeMirrorPanel mirror={mirror} busy={busy} onAction={(input) => void mirrorAction(input)} />
          <PlanPreview plan={plan} busy={busy} job={job} onPreview={() => void previewPlan()} onApply={() => { if (plan !== undefined) void props.api.applyPlan(plan.id).then(setJob); }} />
          <CheckpointEditor versionId={selectedId ?? initial.value.graph.refs.find((ref) => ref.name === "canonical")?.versionId} logicalSessionId={props.logicalSessionId} checkpoints={initial.value.checkpoints} onCreate={createCheckpoint} />
        </> : null}
      </div>
    </Surface>
  </div>;
}
