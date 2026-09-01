import { useMemo, useState } from "react";
import { ChevronRight, FolderKanban, Search } from "lucide-react";

import type {
  CanonicalDashboardSessionSummary,
  CanonicalProjectDirectory,
  LogicalProject,
  ProjectRoot,
} from "@linmu/dsh-session-contracts";
import { Badge, EmptyState } from "@linmu/dsh-session-ui";

import { canonicalOriginLabel } from "./canonical-labels.js";

export interface CanonicalProjectGroup {
  readonly project: LogicalProject | null;
  readonly roots: readonly ProjectRoot[];
  readonly sessions: readonly CanonicalDashboardSessionSummary[];
}

export function buildCanonicalProjectDirectory(directory: CanonicalProjectDirectory): readonly CanonicalProjectGroup[] {
  const groups: CanonicalProjectGroup[] = [...directory.projects]
    .sort((left, right) => left.project.sortKey.localeCompare(right.project.sortKey) || left.project.id.localeCompare(right.project.id));
  if (directory.unclassified.length > 0) groups.push({ project: null, roots: [], sessions: directory.unclassified });
  return groups;
}

function SessionList(props: { readonly sessions: readonly CanonicalDashboardSessionSummary[]; readonly onOpen: (id: string) => void }) {
  return <div className="canonical-session-list" role="list" aria-label="项目会话列表">
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

export function ProjectDirectory(props: {
  readonly directory: CanonicalProjectDirectory;
  readonly onOpenSession: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => buildCanonicalProjectDirectory(props.directory), [props.directory]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const needle = query.trim().toLocaleLowerCase();
  const visible = groups.map((group) => ({
    ...group,
    sessions: group.sessions.filter(({ session }) => needle.length === 0
      || session.title.toLocaleLowerCase().includes(needle)
      || session.id.toLocaleLowerCase().includes(needle)
      || (group.project?.name.toLocaleLowerCase().includes(needle) ?? false)),
  })).filter((group) => group.sessions.length > 0);
  if (groups.length === 0) return <EmptyState title="还没有稳定会话" description="同步或创建会话后，这里会按项目展示；工作区在会话详情中独立显示。" />;
  return <div className="workspace-browser project-browser">
    <label className="workspace-search"><Search size={15} /><span className="sr-only">搜索项目或会话</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目或会话" /></label>
    <div className="workspace-directory" aria-label="Maintenance 项目会话目录">
      {visible.map((group) => {
        const id = group.project?.id ?? "unclassified";
        const open = !collapsed.has(id);
        return <section className="workspace-folder project-folder" key={id} data-testid={`canonical-project-${id}`}>
          <button className="workspace-folder-row" type="button" aria-expanded={open} onClick={() => setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
          })}>
            <ChevronRight className="workspace-chevron" size={16} data-expanded={open} />
            <FolderKanban size={18} />
            <span className="workspace-folder-title"><strong>{group.project?.name ?? "待指定项目"}</strong><small>{group.sessions.length} 个会话</small></span>
            <span className="project-root-label">{group.roots[0]?.path ?? (group.project === null ? "尚未分配" : "无项目根")}</span>
          </button>
          {open ? <div className="workspace-folder-content"><SessionList sessions={group.sessions} onOpen={props.onOpenSession} /></div> : null}
        </section>;
      })}
      {visible.length === 0 ? <EmptyState title="没有匹配结果" description="换一个项目名、会话标题或逻辑会话 ID 再试。" /> : null}
    </div>
  </div>;
}
