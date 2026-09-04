import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Activity, ArrowLeft, BookmarkCheck, GitPullRequest, History, ListTree, Plug, RadioTower, RefreshCw, Settings2, ShieldCheck, Trash2 } from "lucide-react";

import {
  Badge,
  Button,
  DashboardShell,
  EmptyState,
  LoadingState,
  Metric,
  NavButton,
  Surface,
  statusTone,
} from "@linmu/dsh-session-ui";

import {
  loadDashboardSummary,
  type DashboardSummary,
} from "./summary-loader.js";
import type { WorkbenchApi } from "./session-workbench.js";
import type { OperationsApi } from "./operations-pages.js";
import type { CatalogApi } from "./catalog-pages.js";
import type { RecentlyDeletedApi } from "./recently-deleted.js";
import type { RunCenterApi } from "./run-center.js";
import type { AdapterPageApi } from "./adapter-page.js";
import { ProjectDirectory } from "./project-directory.js";

const SessionWorkbench = lazy(async () => ({ default: (await import("./session-workbench.js")).SessionWorkbench }));
const PlansPage = lazy(async () => ({ default: (await import("./catalog-pages.js")).PlansPage }));
const CheckpointsPage = lazy(async () => ({ default: (await import("./catalog-pages.js")).CheckpointsPage }));
const TransactionsPage = lazy(async () => ({ default: (await import("./operations-pages.js")).TransactionsPage }));
const DiagnosticsPage = lazy(async () => ({ default: (await import("./operations-pages.js")).DiagnosticsPage }));
const SettingsPage = lazy(async () => ({ default: (await import("./operations-pages.js")).SettingsPage }));
const RecentlyDeletedPage = lazy(async () => ({ default: (await import("./recently-deleted.js")).RecentlyDeletedPage }));
const RunCenterPage = lazy(async () => ({ default: (await import("./run-center.js")).RunCenterPage }));
const AdapterPage = lazy(async () => ({ default: (await import("./adapter-page.js")).AdapterPage }));

type View = "overview" | "sessions" | "plans" | "checkpoints" | "transactions" | "diagnostics" | "runs" | "adapters" | "deleted" | "settings";
type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly value: DashboardSummary };

function DashboardContent(props: {
  readonly api: WorkbenchApi & OperationsApi;
  readonly state: LoadState;
  readonly view: "overview" | "sessions";
  readonly onRetry: () => void;
  readonly onOpenSession: (id: string) => void;
  readonly refreshKey: number;
}) {
  if (props.state.kind === "loading") return <Surface><LoadingState /></Surface>;
  if (props.state.kind === "error") return <Surface><EmptyState
    kind="offline"
    title="维护引擎暂时不可用"
    description={props.state.message}
    action={<Button onClick={props.onRetry}>重试</Button>}
  /></Surface>;
  const { overview, canonicalDirectory } = props.state.value;
  if (props.view === "sessions") return <>
    <div className="dsm-page-heading"><div><h2>会话</h2><p>按项目浏览 Maintenance 稳定会话；每个会话的工作区在详情中独立展示。</p></div></div>
    <Surface title={`${canonicalDirectory.projects.length} 个项目`}>
      <ProjectDirectory key={props.refreshKey} directory={canonicalDirectory} onOpenSession={props.onOpenSession} />
    </Surface>
  </>;
  return <>
    <div className="dsm-page-heading"><div><h2>概览</h2><p>当前登记平台与需要人工关注的会话状态。</p></div></div>
    <div className="dsm-metrics">
      <Metric label="逻辑会话" value={overview.sessions} />
      <Metric label="冲突或分叉" value={overview.conflicts} tone={overview.conflicts > 0 ? "warning" : "success"} />
      <Metric label="未映射" value={overview.unmapped} tone={overview.unmapped > 0 ? "info" : "success"} />
      <Metric label="未完成事务" value={overview.unresolvedTransactions} tone={overview.unresolvedTransactions > 0 ? "danger" : "success"} />
    </div>
    <Surface title="已登记平台">
      <div className="instance-list">
        {overview.instances.map((instance) => <div className="instance-row" key={instance.id}>
          <div><strong>{instance.displayName}</strong><code>{instance.id}</code></div>
          <Badge>{instance.platform}</Badge>
          <Badge tone={statusTone(instance.compatibility.status)}>{instance.compatibility.status}</Badge>
        </div>)}
      </div>
    </Surface>
  </>;
}

export function DashboardApp(props: { readonly api: WorkbenchApi & OperationsApi & CatalogApi & RecentlyDeletedApi & RunCenterApi & AdapterPageApi; readonly initialLogicalSessionId?: string }) {
  const [view, setView] = useState<View>("overview");
  const [request, setRequest] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>(props.initialLogicalSessionId);
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    void loadDashboardSummary(props.api, controller.signal).then(
      (value) => setState({ kind: "ready", value }),
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ kind: "error", message: error instanceof Error ? error.message : "无法连接本机维护引擎" });
      },
    );
    return () => controller.abort();
  }, [props.api, request]);

  const nav = useMemo(() => <>
    <NavButton active={view === "overview" && selectedSessionId === undefined} icon={Activity} onClick={() => { setSelectedSessionId(undefined); setView("overview"); }}>概览</NavButton>
    <NavButton active={view === "sessions" || selectedSessionId !== undefined} icon={ListTree} onClick={() => { setSelectedSessionId(undefined); setView("sessions"); }}>会话</NavButton>
    <NavButton active={view === "plans"} icon={GitPullRequest} onClick={() => { setSelectedSessionId(undefined); setView("plans"); }}>计划</NavButton>
    <NavButton active={view === "checkpoints"} icon={BookmarkCheck} onClick={() => { setSelectedSessionId(undefined); setView("checkpoints"); }}>Checkpoints</NavButton>
    <NavButton active={view === "transactions"} icon={History} onClick={() => { setSelectedSessionId(undefined); setView("transactions"); }}>事务与恢复</NavButton>
    <NavButton active={view === "diagnostics"} icon={ShieldCheck} onClick={() => { setSelectedSessionId(undefined); setView("diagnostics"); }}>诊断</NavButton>
    <NavButton active={view === "runs"} icon={RadioTower} onClick={() => { setSelectedSessionId(undefined); setView("runs"); }}>运行中心</NavButton>
    <NavButton active={view === "adapters"} icon={Plug} onClick={() => { setSelectedSessionId(undefined); setView("adapters"); }}>Adapter</NavButton>
    <NavButton active={view === "deleted"} icon={Trash2} onClick={() => { setSelectedSessionId(undefined); setView("deleted"); }}>最近删除</NavButton>
    <NavButton active={view === "settings"} icon={Settings2} onClick={() => { setSelectedSessionId(undefined); setView("settings"); }}>设置</NavButton>
  </>, [selectedSessionId, view]);

  return <DashboardShell
    title="DSH 会话维护"
    subtitle="本地版本、分支、同步与恢复工作台"
    nav={nav}
    actions={<Button onClick={() => setRequest((value) => value + 1)}><RefreshCw size={14} /> 刷新</Button>}
  >
    {selectedSessionId !== undefined ? <>
        <div className="workbench-heading"><Button onClick={() => setSelectedSessionId(undefined)}><ArrowLeft size={14} /> 返回会话</Button><code>{selectedSessionId}</code></div>
        <Suspense fallback={<Surface><LoadingState label="正在打开版本工作台…" /></Surface>}>
          <SessionWorkbench api={props.api} logicalSessionId={selectedSessionId} onOpenSession={setSelectedSessionId} onDeleted={() => { setSelectedSessionId(undefined); setView("deleted"); setRequest((value) => value + 1); }} />
        </Suspense>
      </> : view === "plans" ? <Suspense fallback={<Surface><LoadingState label="正在打开计划…" /></Surface>}><PlansPage api={props.api} /></Suspense>
        : view === "checkpoints" ? <Suspense fallback={<Surface><LoadingState label="正在打开 Checkpoint…" /></Surface>}><CheckpointsPage api={props.api} /></Suspense>
          : view === "transactions" ? <Suspense fallback={<Surface><LoadingState label="正在打开事务…" /></Surface>}><TransactionsPage api={props.api} /></Suspense>
            : view === "diagnostics" ? <Suspense fallback={<Surface><LoadingState label="正在打开诊断…" /></Surface>}><DiagnosticsPage api={props.api} /></Suspense>
              : view === "runs" ? <Suspense fallback={<Surface><LoadingState label="正在打开运行中心…" /></Surface>}><RunCenterPage api={props.api} /></Suspense>
                : view === "adapters" ? <Suspense fallback={<Surface><LoadingState label="正在打开 Adapter…" /></Surface>}><AdapterPage api={props.api} /></Suspense>
                  : view === "deleted" ? <Suspense fallback={<Surface><LoadingState label="正在打开最近删除…" /></Surface>}><RecentlyDeletedPage api={props.api} onOpenSession={setSelectedSessionId} /></Suspense>
              : view === "settings" ? <Suspense fallback={<Surface><LoadingState label="正在打开设置…" /></Surface>}><SettingsPage api={props.api} /></Suspense>
          : <DashboardContent api={props.api} state={state} view={view} onRetry={() => setRequest((value) => value + 1)} onOpenSession={setSelectedSessionId} refreshKey={request} />}
  </DashboardShell>;
}

export function DashboardOffline() {
  return <DashboardShell title="DSH 会话维护" subtitle="本地版本、分支、同步与恢复工作台" nav={null}>
    <Surface><EmptyState
      kind="offline"
      title="缺少本次启动凭据"
      description="请从 Maintenance 启动入口打开看板。浏览器只使用短期 HttpOnly 会话，不会读取 Engine capability。"
    /></Surface>
  </DashboardShell>;
}
