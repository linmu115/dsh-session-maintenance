import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, FolderKanban, GitBranch, Link2, MessageSquare, FileText, RefreshCw } from "lucide-react";
import { Button, EmptyState, LoadingState, Surface } from "@linmu/dsh-session-ui";
import type { ExtensionBusinessPanel, ExtensionBusinessPanelQuery, ExtensionDirectoryQuery, ExtensionDirectoryPage, ExtensionDirectoryObject, ExtensionDirectoryGroup, ExtensionPanel, ExtensionScope } from "@linmu/dsh-session-contracts";
import "./extension-directory.css";

export interface ExtensionBusinessApi {
  listExtensionBusinessPanels(filter?: ExtensionBusinessPanelQuery, signal?: AbortSignal): Promise<ExtensionBusinessPanel[]>;
  listExtensionDirectory(query: ExtensionDirectoryQuery, signal?: AbortSignal): Promise<ExtensionDirectoryPage>;
  enableExtension(scope: ExtensionScope, enabled: boolean): Promise<ExtensionPanel[]>;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : "扩展目录暂时无法读取";
const statusLabels = { ready: "已接入", partial: "部分能力不可用", disabled: "已停用，数据保留", "missing-adapter": "缺少适配器，数据保留", incompatible: "版本不兼容，数据保留" };
const kindLabels: Record<string, string> = { "native-context": "上下文使用状态", "reference-record": "引用", "message-reference": "会话引用", "obsidian-reference": "Obsidian 引用", "session-context": "跨会话引用", "upstream-reference": "跨会话引用", "session": "会话贴纸", "session-sticker": "会话贴纸", "annotation": "普通贴纸", "annotation-sticker": "普通贴纸", "note-link": "笔记关联", "graph": "主干图", "main-graph": "主干图", "disclosure-log": "披露记录", migration: "迁移记录", "migration-receipt": "迁移记录" };
const scopeKey = (scope: {instanceId: string; profileId: string}) => JSON.stringify([scope.instanceId, scope.profileId]);
const objectKey = (object: ExtensionDirectoryObject) => JSON.stringify([object.scope, object.objectId]);

export function ExtensionBusinessDirectory({ api, onOpenSession, renderDetail, hideAdapterNavigation = false }: {
  api: ExtensionBusinessApi;
  onOpenSession(id: string): void;
  renderDetail(object: ExtensionDirectoryObject, member: ExtensionPanel, onChanged: () => void): ReactNode;
  hideAdapterNavigation?: boolean;
}) {
  const [panels, setPanels] = useState<ExtensionBusinessPanel[]>();
  const [scope, setScope] = useState("");
  const [adapter, setAdapter] = useState("");
  const [deleted, setDeleted] = useState<"active" | "deleted" | "all">("active");
  const [selected, setSelected] = useState<ExtensionDirectoryObject>();
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    void api.listExtensionBusinessPanels({}, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setPanels(result);
      setScope(current => result.some(panel => scopeKey(panel.scope) === current) ? current : result[0] ? scopeKey(result[0].scope) : "");
    }, failure => { if (!controller.signal.aborted) setError(errorText(failure)); });
    return () => controller.abort();
  }, [api, refresh]);
  const scopes = useMemo(() => [...new Map((panels ?? []).map(panel => [scopeKey(panel.scope), {key: scopeKey(panel.scope), label: `${panel.instanceLabel} · ${panel.profileLabel}`}])).values()], [panels]);
  const visiblePanels = (panels ?? []).filter(panel => scopeKey(panel.scope) === scope);
  const panel = visiblePanels.find(item => item.adapterId === adapter) ?? visiblePanels[0];
  const member = selected && panel?.members.find(item => item.scope.namespace === selected.scope.namespace);
  const changeView = () => setSelected(undefined);
  const changed = () => { setSelected(undefined); setRefresh(value => value + 1); };
  const toggle = async (item: ExtensionPanel) => {
    setBusy(true); setError(undefined);
    try { await api.enableExtension(item.scope, !item.enabled); changed(); }
    catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  };
  const base = panel ? { ...panel.scope, adapterId: panel.adapterId, deleted } : undefined;
  return <div className="page-stack extension-business-page">
    <div className="dsm-page-heading"><div><h2>扩展数据</h2><p>按工作区和所属会话查看引用、贴纸与主干图。</p></div><Button onClick={changed} disabled={busy}><RefreshCw size={14}/>刷新</Button></div>
    {error ? <p role="alert" className="inline-error">{error}</p> : null}
    {!panels && !error ? <LoadingState label="正在读取适配器…"/> : null}
    {panels?.length === 0 ? <Surface><EmptyState title="尚未接入扩展" description="配置插件并接通 Maintenance 后，对应适配器会出现在这里。"/></Surface> : null}
    {panels && panels.length > 0 ? <>
      <div className="extension-directory-toolbar">
        <label>实例与配置<select aria-label="实例与配置" value={scope} onChange={event => { setScope(event.target.value); changeView(); }}>
          {scopes.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
        </select></label>
        <label>显示<select aria-label="扩展条目状态" value={deleted} onChange={event => { setDeleted(event.target.value as typeof deleted); changeView(); }}>
          <option value="active">当前条目</option><option value="deleted">已归档或删除</option><option value="all">全部条目</option>
        </select></label>
      </div>
      {!hideAdapterNavigation ? <div className="extension-adapter-tabs" role="tablist" aria-label="扩展适配器">
        {visiblePanels.map(item => <button type="button" role="tab" key={item.adapterId} aria-selected={item.adapterId === panel?.adapterId} onClick={() => { setAdapter(item.adapterId); changeView(); }}>
          {item.adapterId === "thoughtdag" ? <GitBranch size={17}/> : <Link2 size={17}/>}<span>{item.label}</span><small>{item.objectCount}</small>
        </button>)}
      </div> : null}
      {panel && base ? <section role="tabpanel" aria-label={panel.label}>
        <div className="extension-adapter-summary"><p>{statusLabels[panel.status]} · {panel.conflictCount} 个冲突</p>
          <details className="extension-member-details"><summary>接入状态</summary><ul>{panel.members.map(item => <li key={item.scope.namespace}><span>{item.label}<small>{statusLabels[item.status]} · {item.pluginVersion}</small></span>
            {item.configured && item.status !== "missing-adapter" && item.status !== "incompatible" ? <Button disabled={busy} onClick={() => void toggle(item)}>{item.enabled ? "停用" : "启用"}</Button> : null}</li>)}</ul></details>
        </div>
        <div className="extension-directory-layout">
          <section className="dsm-surface extension-directory-tree"><DirectoryLevel key={`${scope}:${panel.adapterId}:${deleted}:${refresh}`} api={api} query={{...base, level: "workspaces"}} selected={selected} onSelect={setSelected} onOpenSession={onOpenSession}/></section>
          <section className="dsm-surface extension-directory-detail">
            {selected && member ? <><header><div><small>{kindLabels[selected.kind] ?? "扩展条目"}</small><h3>{selected.label || "未命名条目"}</h3></div>{selected.ownerSessionId ? <Button onClick={() => onOpenSession(selected.ownerSessionId!)}>打开所属会话</Button> : null}</header>
              {selected.ownershipReason ? <p className="muted">{selected.ownershipReason}</p> : null}
              {selected.unavailableReason || member.status !== "ready" || !member.capabilities?.read ? <div><p>{selected.unavailableReason ?? statusLabels[member.status]}</p><p>版本 {selected.revision} · {selected.conflicts} 个冲突</p><code>{selected.objectId}</code></div> : <>
                {renderDetail(selected, member, changed)}
                {selected.count > 0 && !selected.parentObjectId ? <LazyAttachedRecords key={objectKey(selected)} count={selected.count} api={api} query={{...base, deleted: "all", level: "objects", ownerSessionId: selected.ownerSessionId ?? "@unbound", parentObjectId: selected.objectId}} onSelect={setSelected} onOpenSession={onOpenSession}/> : null}
              </>}
            </> : <EmptyState title="选择一个条目" description="展开左侧工作区和会话，查看该会话拥有的扩展数据。来源会话会在条目详情中显示。"/>}
          </section>
        </div>
      </section> : null}
    </> : null}
  </div>;
}

function LazyAttachedRecords(props: {count: number; api: ExtensionBusinessApi; query: ExtensionDirectoryQuery; onSelect(item: ExtensionDirectoryObject): void; onOpenSession(id: string): void}) {
  const [open, setOpen] = useState(false);
  return <details className="extension-attached-records" onToggle={event => setOpen(event.currentTarget.open)}><summary>披露与附属记录 · {props.count}</summary>{open ? <DirectoryLevel {...props}/> : null}</details>;
}

function DirectoryLevel({api, query, selected, onSelect, onOpenSession}: {
  api: ExtensionBusinessApi; query: ExtensionDirectoryQuery; selected?: ExtensionDirectoryObject | undefined;
  onSelect(item: ExtensionDirectoryObject): void; onOpenSession(id: string): void;
}) {
  const key = JSON.stringify(query);
  const [items, setItems] = useState<ExtensionDirectoryPage["items"]>([]);
  const [cursor, setCursor] = useState<string>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(undefined);
    void api.listExtensionDirectory({...JSON.parse(key) as ExtensionDirectoryQuery, limit: 30, ...(cursor ? {after: cursor} : {})}, controller.signal).then(page => {
      if (controller.signal.aborted) return;
      setItems(previous => cursor ? [...previous, ...page.items.filter(item => !previous.some(existing => existing.type === "object" && item.type === "object" ? objectKey(existing) === objectKey(item) : existing.id === item.id && existing.type === item.type))] : page.items);
      setNextCursor(page.nextCursor); setLoading(false);
    }, failure => { if (!controller.signal.aborted) { setError(errorText(failure)); setLoading(false); } });
    return () => controller.abort();
  }, [api, key, cursor]);
  return <div className={`extension-tree-level extension-tree-${query.level}`} aria-label={query.level === "workspaces" ? "扩展工作区目录" : query.level === "sessions" ? "所属会话目录" : "会话扩展条目"}>
    {items.map(item => item.type === "object" ? <button type="button" className="extension-object-row" key={`${item.scope.namespace}:${item.id}`} aria-pressed={selected ? objectKey(selected) === objectKey(item) : false} onClick={() => onSelect(item)}>
      <FileText size={16}/><span><strong>{item.label || "未命名条目"}</strong><small>{kindLabels[item.kind] ?? "扩展条目"}{item.archived ? " · 已归档" : item.deleted ? " · 已删除" : ""}{item.unavailableReason ? " · 暂不可读取" : ""}{item.conflicts ? ` · ${item.conflicts} 个冲突` : ""}</small></span>
    </button> : <DirectoryBranch key={item.id} item={item} api={api} query={query} selected={selected} onSelect={onSelect} onOpenSession={onOpenSession}/>)}
    {loading ? <LoadingState label="正在读取目录…"/> : null}
    {error ? <p role="alert" className="inline-error">{error}</p> : null}
    {!loading && !error && items.length === 0 ? <p className="extension-directory-empty">这里还没有条目。</p> : null}
    {nextCursor && !loading ? <div className="workspace-load-more"><Button onClick={() => setCursor(nextCursor)}>加载更多</Button></div> : null}
  </div>;
}

function DirectoryBranch({item, api, query, selected, onSelect, onOpenSession}: {
  item: ExtensionDirectoryGroup; api: ExtensionBusinessApi; query: ExtensionDirectoryQuery; selected?: ExtensionDirectoryObject | undefined;
  onSelect(item: ExtensionDirectoryObject): void; onOpenSession(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const workspace = item.type === "workspace";
  const nextQuery: ExtensionDirectoryQuery = workspace ? {...query, level: "sessions", workspaceId: item.id} : {...query, level: "objects", ownerSessionId: item.id};
  return <section className={`extension-tree-branch ${workspace ? "extension-workspace-branch" : "extension-session-branch"}`}>
    <div className="extension-branch-heading"><button type="button" className="extension-branch-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <ChevronRight className="workspace-chevron" size={15} data-expanded={open}/>{workspace ? <FolderKanban size={18}/> : <MessageSquare size={16}/>}<span><strong>{item.label}</strong>{item.archived ? <small>已归档</small> : null}</span><small>{item.count}</small>
    </button>{!workspace && item.id !== "@unbound" && !item.missing ? <button type="button" className="extension-session-open" onClick={() => onOpenSession(item.id)} aria-label={`打开会话 ${item.label}`}>打开</button> : null}</div>
    {open ? <DirectoryLevel api={api} query={nextQuery} selected={selected} onSelect={onSelect} onOpenSession={onOpenSession}/> : null}
  </section>;
}
