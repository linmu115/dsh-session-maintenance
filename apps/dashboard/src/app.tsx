import { useEffect, useMemo, useState } from "react";
import { Activity, ListTree, RefreshCw } from "lucide-react";

import type { Page, SessionSummary } from "@linmu/dsh-session-contracts";
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
  loadSessionPage,
  type DashboardSummary,
  type DashboardSummaryApi,
} from "./summary-loader.js";

type View = "overview" | "sessions";
type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly value: DashboardSummary };

function SessionTable(props: { readonly page: Page<SessionSummary> }) {
  if (props.page.items.length === 0) {
    return <EmptyState title="还没有会话基线" description="运行一次扫描后，这里会显示逻辑会话摘要；正文和版本历史不会在此页面预加载。" />;
  }
  return <div className="session-table" role="table" aria-label="会话列表">
    <div className="session-row session-row-head" role="row">
      <span>会话</span><span>平台</span><span>状态</span><span>更新时间</span>
    </div>
    {props.page.items.map((session) => <div className="session-row" role="row" key={session.logicalSessionId}>
      <div className="session-title">
        <strong>{session.title}</strong>
        <code>{session.logicalSessionId}</code>
      </div>
      <span>{session.platforms.map((platform) => <Badge key={platform}>{platform}</Badge>)}</span>
      <span><Badge tone={statusTone(session.status)}>{session.status}</Badge></span>
      <time dateTime={session.updatedAt}>{new Date(session.updatedAt).toLocaleString()}</time>
    </div>)}
  </div>;
}

function DashboardContent(props: {
  readonly state: LoadState;
  readonly view: View;
  readonly onRetry: () => void;
  readonly onLoadNext: () => void;
  readonly loadingNext: boolean;
}) {
  if (props.state.kind === "loading") return <Surface><LoadingState /></Surface>;
  if (props.state.kind === "error") return <Surface><EmptyState
    kind="offline"
    title="维护引擎暂时不可用"
    description={props.state.message}
    action={<Button onClick={props.onRetry}>重试</Button>}
  /></Surface>;
  const { overview, sessions } = props.state.value;
  if (props.view === "sessions") return <>
    <div className="dsm-page-heading"><div><h2>会话</h2><p>只读取摘要；打开会话后才加载版本树和正文。</p></div></div>
    <Surface
      title={`${sessions.items.length} 个已加载会话`}
      action={sessions.nextCursor === undefined ? null : <Button disabled={props.loadingNext} onClick={props.onLoadNext}>
        {props.loadingNext ? "正在加载…" : "加载下一页"}
      </Button>}
    ><SessionTable page={sessions} /></Surface>
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

export function DashboardApp(props: { readonly api: DashboardSummaryApi }) {
  const [view, setView] = useState<View>("overview");
  const [request, setRequest] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [loadingNext, setLoadingNext] = useState(false);
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
    <NavButton active={view === "overview"} icon={Activity} onClick={() => setView("overview")}>概览</NavButton>
    <NavButton active={view === "sessions"} icon={ListTree} onClick={() => setView("sessions")}>会话</NavButton>
  </>, [view]);

  const loadNext = async () => {
    if (state.kind !== "ready" || state.value.sessions.nextCursor === undefined) return;
    setLoadingNext(true);
    try {
      const next = await loadSessionPage(props.api, state.value.sessions.nextCursor);
      setState({ kind: "ready", value: {
        ...state.value,
        sessions: { items: [...state.value.sessions.items, ...next.items], ...(next.nextCursor === undefined ? {} : { nextCursor: next.nextCursor }) },
      } });
    } finally { setLoadingNext(false); }
  };

  return <DashboardShell
    title="DSH 会话维护"
    subtitle="本地版本、分支、同步与恢复工作台"
    nav={nav}
    actions={<Button onClick={() => setRequest((value) => value + 1)}><RefreshCw size={14} /> 刷新</Button>}
  >
    <DashboardContent state={state} view={view} onRetry={() => setRequest((value) => value + 1)} onLoadNext={() => void loadNext()} loadingNext={loadingNext} />
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
