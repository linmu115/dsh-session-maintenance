import { useMemo, useState } from "react";
import { ChevronRight, Folder, FolderOpen, Search } from "lucide-react";

import type {
  CanonicalDashboardSessionSummary,
  CanonicalDashboardWorkspace,
  CanonicalWorkspaceDirectory,
} from "@linmu/dsh-session-contracts";
import { Badge, EmptyState } from "@linmu/dsh-session-ui";

import { canonicalOriginLabel } from "./canonical-labels.js";

export interface CanonicalWorkspaceNode extends CanonicalDashboardWorkspace {
  readonly children: readonly CanonicalWorkspaceNode[];
}

export function buildCanonicalWorkspaceTree(directory: CanonicalWorkspaceDirectory): readonly CanonicalWorkspaceNode[] {
  const nodes = new Map(directory.workspaces.map((entry) => [entry.workspace.id, { ...entry, children: [] as CanonicalWorkspaceNode[] }]));
  const roots: CanonicalWorkspaceNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.workspace.parentId === null ? undefined : nodes.get(node.workspace.parentId);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }
  const sort = (items: CanonicalWorkspaceNode[]): void => {
    items.sort((left, right) => left.workspace.sortKey.localeCompare(right.workspace.sortKey) || left.workspace.id.localeCompare(right.workspace.id));
    for (const item of items) sort(item.children as CanonicalWorkspaceNode[]);
  };
  sort(roots);
  return roots;
}

function SessionList(props: { readonly sessions: readonly CanonicalDashboardSessionSummary[]; readonly onOpen: (id: string) => void }) {
  if (props.sessions.length === 0) return <p className="muted">这个工作区暂无会话。</p>;
  return <div className="canonical-session-list" role="list" aria-label="稳定会话列表">
    {[...props.sessions].sort((left, right) => {
      if ((left.membership?.pinned ?? false) !== (right.membership?.pinned ?? false)) return left.membership?.pinned === true ? -1 : 1;
      return (left.membership?.displayOrder ?? 0) - (right.membership?.displayOrder ?? 0) || right.session.updatedAt.localeCompare(left.session.updatedAt);
    }).map(({ session, membership }) => <button
      type="button"
      role="listitem"
      className="canonical-session-row"
      data-testid={`canonical-session-${session.id}`}
      key={session.id}
      onClick={() => props.onOpen(session.id)}
      aria-label={`打开会话 ${session.title}，来源 ${canonicalOriginLabel(session.originKind)}`}
    >
      <span><strong>{session.title || "未命名会话"}</strong><code>{session.id}</code></span>
      <span className="canonical-session-badges">
        {membership?.pinned === true ? <Badge tone="info">置顶</Badge> : null}
        {membership?.archived === true || session.archivedAt !== null ? <Badge>已归档</Badge> : null}
        <Badge>{canonicalOriginLabel(session.originKind)}</Badge>
      </span>
      <time dateTime={session.updatedAt}>{new Date(session.updatedAt).toLocaleString()}</time>
    </button>)}
  </div>;
}

function WorkspaceBranch(props: {
  readonly node: CanonicalWorkspaceNode;
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  readonly onOpenSession: (id: string) => void;
}) {
  const open = props.expanded.has(props.node.workspace.id);
  return <section className="workspace-folder" role="treeitem" aria-expanded={open} data-testid={`canonical-workspace-${props.node.workspace.id}`}>
    <button className="workspace-folder-row" type="button" onClick={() => props.onToggle(props.node.workspace.id)}>
      <ChevronRight className="workspace-chevron" size={16} data-expanded={open} />
      {open ? <FolderOpen size={18} /> : <Folder size={18} />}
      <span className="workspace-folder-title"><strong>{props.node.workspace.name}</strong><small>{props.node.sessions.length} 个直属会话</small></span>
    </button>
    {open ? <div className="workspace-folder-content" role="group">
      <SessionList sessions={props.node.sessions} onOpen={props.onOpenSession} />
      {props.node.children.map((child) => <WorkspaceBranch key={child.workspace.id} node={child} expanded={props.expanded} onToggle={props.onToggle} onOpenSession={props.onOpenSession} />)}
    </div> : null}
  </section>;
}

export function WorkspaceDirectory(props: {
  readonly directory: CanonicalWorkspaceDirectory;
  readonly onOpenSession: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const tree = useMemo(() => buildCanonicalWorkspaceTree(props.directory), [props.directory]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(tree.map((node) => node.workspace.id)));
  const needle = query.trim().toLocaleLowerCase();
  const matches = (session: CanonicalDashboardSessionSummary) => needle.length === 0
    || session.session.title.toLocaleLowerCase().includes(needle)
    || session.session.id.toLocaleLowerCase().includes(needle);
  const filterNode = (node: CanonicalWorkspaceNode): CanonicalWorkspaceNode | undefined => {
    const children = node.children.map(filterNode).filter((child): child is CanonicalWorkspaceNode => child !== undefined);
    const sessions = node.sessions.filter(matches);
    if (needle.length === 0 || node.workspace.name.toLocaleLowerCase().includes(needle) || sessions.length > 0 || children.length > 0) return { ...node, sessions, children };
    return undefined;
  };
  const filtered = tree.map(filterNode).filter((node): node is CanonicalWorkspaceNode => node !== undefined);
  const unclassified = props.directory.unclassified.filter(matches);
  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  if (tree.length === 0 && props.directory.unclassified.length === 0) return <EmptyState title="还没有稳定会话" description="导入或投影会话后，这里会按 Maintenance 工作区展示。" />;
  return <div className="workspace-browser">
    <label className="workspace-search"><Search size={15} /><span className="sr-only">搜索工作区或会话</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索工作区或会话" /></label>
    <div className="workspace-directory" role="tree" aria-label="Maintenance 工作区会话目录">
      {filtered.map((node) => <WorkspaceBranch key={node.workspace.id} node={node} expanded={expanded} onToggle={toggle} onOpenSession={props.onOpenSession} />)}
      {unclassified.length > 0 ? <section className="workspace-folder canonical-unclassified" role="treeitem" aria-expanded="true" data-testid="canonical-workspace-unclassified">
        <div className="workspace-folder-row"><FolderOpen size={18} /><span className="workspace-folder-title"><strong>未归类</strong><small>{unclassified.length} 个会话</small></span></div>
        <div className="workspace-folder-content" role="group"><SessionList sessions={unclassified} onOpen={props.onOpenSession} /></div>
      </section> : null}
      {filtered.length === 0 && unclassified.length === 0 ? <EmptyState title="没有匹配结果" description="换一个工作区、标题或逻辑会话 ID 再试。" /> : null}
    </div>
  </div>;
}
