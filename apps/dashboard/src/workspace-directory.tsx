import { useMemo, useState } from "react";
import { ChevronRight, Folder, FolderOpen, Search } from "lucide-react";

import type { Page, SessionSummary, WorkspaceSummary } from "@linmu/dsh-session-contracts";
import { Badge, Button, EmptyState, LoadingState, statusTone } from "@linmu/dsh-session-ui";

import { loadWorkspaceSessionPage, type DashboardSummaryApi } from "./summary-loader.js";

type FolderState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly page: Page<SessionSummary>; readonly loadingNext: boolean };

const UNCLASSIFIED_KEY = "__unclassified__";

function workspaceKey(summary: WorkspaceSummary): string {
  return summary.workspace?.id ?? UNCLASSIFIED_KEY;
}

function SessionTable(props: { readonly page: Page<SessionSummary>; readonly onOpen: (id: string) => void }) {
  if (props.page.items.length === 0) {
    return <EmptyState title="这个工作区还没有会话" description="刷新扫描后再查看。" />;
  }
  return <div className="session-table" role="table" aria-label="会话列表">
    <div className="session-row session-row-head" role="row">
      <span>会话</span><span>平台</span><span>状态</span><span>更新时间</span>
    </div>
    {props.page.items.map((session) => <button className="session-row" role="row" type="button" key={session.logicalSessionId} onClick={() => props.onOpen(session.logicalSessionId)}>
      <div className="session-title">
        <strong>{session.title}</strong>
        <code>{session.logicalSessionId}</code>
      </div>
      <span>{session.platforms.map((platform) => <Badge key={platform}>{platform}</Badge>)}</span>
      <span><Badge tone={statusTone(session.status)}>{session.status}</Badge></span>
      <time dateTime={session.updatedAt}>{new Date(session.updatedAt).toLocaleString()}</time>
    </button>)}
  </div>;
}

export function WorkspaceDirectory(props: {
  readonly api: DashboardSummaryApi;
  readonly workspaces: readonly WorkspaceSummary[];
  readonly onOpenSession: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [folders, setFolders] = useState<ReadonlyMap<string, FolderState>>(() => new Map());
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (needle.length === 0) return props.workspaces;
    return props.workspaces.filter((summary) =>
      (summary.workspace?.name ?? "未归类").toLocaleLowerCase().includes(needle),
    );
  }, [props.workspaces, query]);

  const loadInitial = async (summary: WorkspaceSummary) => {
    const key = workspaceKey(summary);
    setFolders((current) => new Map(current).set(key, { kind: "loading" }));
    try {
      const page = await loadWorkspaceSessionPage(props.api, summary.workspace?.id ?? null);
      setFolders((current) => new Map(current).set(key, { kind: "ready", page, loadingNext: false }));
    } catch (error) {
      setFolders((current) => new Map(current).set(key, {
        kind: "error",
        message: error instanceof Error ? error.message : "无法读取这个工作区",
      }));
    }
  };

  const toggle = (summary: WorkspaceSummary) => {
    const key = workspaceKey(summary);
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else {
      next.add(key);
      if (!folders.has(key)) void loadInitial(summary);
    }
    setExpanded(next);
  };

  const loadNext = async (summary: WorkspaceSummary, state: Extract<FolderState, { readonly kind: "ready" }>) => {
    if (state.page.nextCursor === undefined || state.loadingNext) return;
    const key = workspaceKey(summary);
    setFolders((current) => new Map(current).set(key, { ...state, loadingNext: true }));
    try {
      const next = await loadWorkspaceSessionPage(props.api, summary.workspace?.id ?? null, state.page.nextCursor);
      setFolders((current) => new Map(current).set(key, {
        kind: "ready",
        loadingNext: false,
        page: {
          items: [...state.page.items, ...next.items],
          ...(next.nextCursor === undefined ? {} : { nextCursor: next.nextCursor }),
        },
      }));
    } catch (error) {
      setFolders((current) => new Map(current).set(key, {
        kind: "error",
        message: error instanceof Error ? error.message : "无法读取下一页",
      }));
    }
  };

  if (props.workspaces.length === 0) {
    return <EmptyState title="还没有会话基线" description="运行一次扫描后，这里会按工作区显示会话。" />;
  }

  return <div className="workspace-browser">
    <label className="workspace-search">
      <Search size={15} />
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索工作区" />
    </label>
    <div className="workspace-directory" role="tree" aria-label="工作区会话目录">
      {filtered.map((summary) => {
        const key = workspaceKey(summary);
        const isExpanded = expanded.has(key);
        const state = folders.get(key);
        return <section className="workspace-folder" role="treeitem" aria-expanded={isExpanded} key={key}>
          <button className="workspace-folder-row" type="button" onClick={() => toggle(summary)}>
            <ChevronRight className="workspace-chevron" size={16} data-expanded={isExpanded} />
            {isExpanded ? <FolderOpen size={18} /> : <Folder size={18} />}
            <span className="workspace-folder-title">
              <strong>{summary.workspace?.name ?? "未归类"}</strong>
              <small>{summary.sessionCount} 个会话</small>
            </span>
            <span className="workspace-folder-badges">
              {summary.platforms.map((platform) => <Badge key={platform}>{platform}</Badge>)}
              {summary.conflictCount > 0 ? <Badge tone="warning">{summary.conflictCount} 个分叉</Badge> : null}
              {summary.unmappedCount > 0 ? <Badge tone="info">{summary.unmappedCount} 个单侧</Badge> : null}
            </span>
            <time dateTime={summary.updatedAt}>{new Date(summary.updatedAt).toLocaleDateString()}</time>
          </button>
          {isExpanded ? <div className="workspace-folder-content" role="group">
            {state === undefined || state.kind === "loading" ? <LoadingState label="正在读取这个工作区…" />
              : state.kind === "error" ? <EmptyState kind="offline" title="工作区暂时不可用" description={state.message} action={<Button onClick={() => void loadInitial(summary)}>重试</Button>} />
                : <>
                  <SessionTable page={state.page} onOpen={props.onOpenSession} />
                  {state.page.nextCursor === undefined ? null : <div className="workspace-load-more"><Button disabled={state.loadingNext} onClick={() => void loadNext(summary, state)}>
                    {state.loadingNext ? "正在加载…" : "加载更多会话"}
                  </Button></div>}
                </>}
          </div> : null}
        </section>;
      })}
      {filtered.length === 0 ? <EmptyState title="没有匹配的工作区" description="换一个名称再试。" /> : null}
    </div>
  </div>;
}
