import { useSyncEditorLayout } from "./sync-editor-layout.js";
import { useEffect, useRef, useState } from "react";
import type { InstanceWorkspaceConfiguration, InstanceWorkspaceInstanceDirectory, InstanceWorkspacePolicyUpdate, InstanceWorkspaceSelection, LogicalWorkspaceId } from "@linmu/dsh-session-contracts";
import { Badge, Button, EmptyState, LoadingState, Surface } from "@linmu/dsh-session-ui";

export interface InstanceWorkspaceApi {
  listInstanceWorkspaceInstances?(signal?: AbortSignal): Promise<InstanceWorkspaceInstanceDirectory>;
  getInstanceWorkspaceSync?(instanceId: string, signal?: AbortSignal): Promise<InstanceWorkspaceConfiguration>;
  saveInstanceWorkspaceSync?(instanceId: string, input: InstanceWorkspacePolicyUpdate, signal?: AbortSignal): Promise<InstanceWorkspaceConfiguration>;
}
const message = (error: unknown) => error instanceof Error ? error.message : "无法读取实例同步范围，请重试。";
function summary(selection: InstanceWorkspaceSelection, configuration: InstanceWorkspaceConfiguration): string {
  if (selection.kind === "all") return "全部工作区及未分组会话";
  const names = selection.workspaceIds.map(id => configuration.workspaces.find(workspace => workspace.id === id)?.name ?? id);
  if (selection.includeUnassigned) names.push("未分组会话");
  return names.length ? names.join("、") : "不向此实例同步任何会话";
}
function InstanceEditor({ api, instanceId }: { api: InstanceWorkspaceApi; instanceId: string }) {
  const editorLayout = useSyncEditorLayout<HTMLFormElement>();
  const [configuration, setConfiguration] = useState<InstanceWorkspaceConfiguration>();
  // Mirrors the engine default for an instance without a saved selection: nothing is synchronised.
  const [selection, setSelection] = useState<InstanceWorkspaceSelection>({ kind: "ids", workspaceIds: [], includeUnassigned: false });
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const install = (value: InstanceWorkspaceConfiguration) => {
    if (value.policy.instanceId !== instanceId) throw new Error("返回的配置不属于当前实例，请重新读取。");
    setConfiguration(value); setSelection(value.policy.selection);
  };
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    setConfiguration(undefined); setError(undefined); setNotice(undefined); setBusy(false);
    if (!api.getInstanceWorkspaceSync) setError("当前维护引擎未提供实例同步配置。");
    else void api.getInstanceWorkspaceSync(instanceId, controller.signal).then(value => {
      if (!controller.signal.aborted) install(value);
    }).catch(reason => { if (!controller.signal.aborted) setError(message(reason)); });
    return () => controller.abort();
  }, [api, instanceId, reload]);
  const save = async () => {
    if (!configuration || !editing || busy || !api.saveInstanceWorkspaceSync) return;
    const signal = lifetime.current!.signal;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const value = await api.saveInstanceWorkspaceSync(instanceId, { expectedRevision: configuration.policy.revision, selection }, signal);
      if (!signal.aborted) { install(value); setEditing(false); setNotice("已保存 · 下次启动生效"); }
    } catch (reason) {
      if (signal.aborted) return;
      const failure = reason as { status?: number; code?: string };
      setError(message(reason));
      if (failure?.status === 409 || failure?.code === "INSTANCE_WORKSPACE_POLICY_CONFLICT") {
        try {
          const latest = await api.getInstanceWorkspaceSync!(instanceId, signal);
          if (!signal.aborted) { setConfiguration(latest); setNotice("已重新读取最新范围；你的勾选已保留，请核对后再保存。"); }
        } catch (refreshError) { if (!signal.aborted) setError(`${message(reason)} 重新读取失败：${message(refreshError)}`); }
      }
    } finally { if (!signal.aborted) setBusy(false); }
  };
  const changed = configuration && JSON.stringify(selection) !== JSON.stringify(configuration.policy.selection);
  const toggle = (id: LogicalWorkspaceId, checked: boolean) => {
    setSelection(previous => {
      const ids = previous.kind === "all" ? configuration!.workspaces.filter(workspace => !workspace.deleted).map(workspace => workspace.id) : previous.workspaceIds;
      return { kind: "ids", includeUnassigned: previous.kind === "all" || previous.includeUnassigned,
        workspaceIds: checked ? [...new Set([...ids, id])].sort() : ids.filter(candidate => candidate !== id) };
    });
    setNotice(undefined);
  };
  const visible = configuration?.workspaces.filter(workspace => `${workspace.name} ${workspace.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
  const selectedCount = selection.kind === "all" ? configuration?.workspaces.filter(workspace => !workspace.deleted).length ?? 0 : selection.workspaceIds.length;
  return <div className="settings-content instance-workspace-editor">
    {error ? <p role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {!configuration ? <>{!error ? <LoadingState label="正在读取实例范围…" /> : null}<Button onClick={() => setReload(value => value + 1)}>重新读取范围</Button></> : <>
      <details className="mapping-runtime-details"><summary>运行详情</summary><div className="mapping-policy-status instance-workspace-status">
        <section aria-label="当前运行范围"><h3>当前运行范围</h3>
          {configuration.activeScopes.length ? <>
            <details className="instance-scope-details"><summary>查看 {configuration.activeScopes.length} 条运行范围</summary>
            <div className="instance-active-scopes">{configuration.activeScopes.map(scope => <details key={scope.runId}>
              <summary><strong>{scope.profileId}</strong> · {summary(scope.selection, configuration)} <span className="muted">（生效修订 {scope.policyRevision}）</span></summary>
              <p>运行标识：<code>{scope.runId}</code></p>
            </details>)}</div></details>
          </> : <p className="muted">实例当前没有在线运行；下次启动将使用已保存范围。</p>}
        </section>
        <section aria-label="已保存范围"><h3>已保存范围</h3><p>{summary(configuration.policy.selection, configuration)}</p><small>修订 {configuration.policy.revision} · 下次启动采用此范围</small>
          {configuration.pendingActivation ? <p><Badge tone="warning">有保存的更改等待下次启动</Badge></p> : null}
        </section>
      </div>
      </details>
      <details className="maintenance-source-list">
        <summary><strong>Maintenance 真源名单</strong><span className="muted">已保存：{configuration.policy.selection.kind === "all" ? "全部工作区及未分组会话" : `${configuration.policy.selection.workspaceIds.length} 个工作区${configuration.policy.selection.includeUnassigned ? " · 包含未分组会话" : ""}`}{editing && changed ? " · 有未保存的更改" : configuration.pendingActivation ? " · 下次启动生效" : ""}</span></summary>
      <form ref={editorLayout} className="sync-editor-layout" onSubmit={event => { event.preventDefault(); void save(); }}>
        <div className="sync-editor-scroll"><fieldset className="instance-workspace-selection"><legend>此实例下次启动时同步</legend>
          <label className="sync-workspace"><input type="radio" disabled={busy || !editing} name="instance-selection" checked={selection.kind === "all"} onChange={() => setSelection({ kind: "all" })} />全部工作区及未分组会话</label>
          <label className="sync-workspace"><input type="radio" disabled={busy || !editing} name="instance-selection" checked={selection.kind === "ids"} onChange={() => setSelection({ kind: "ids", workspaceIds: [], includeUnassigned: false })} />仅同步以下选择</label>
          <label className="workspace-search"><input aria-label="搜索 Maintenance 真源工作区" type="search" placeholder="搜索工作区名称或标识" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <p className="muted">{visible.length} 个工作区 · 已选 {selectedCount} 个{selection.kind === "all" ? " · 自动包含未来新增工作区" : ""}</p>
          <div className="sync-workspaces">
            {visible.map(workspace => {
              const checked = selection.kind === "all" ? !workspace.deleted : selection.workspaceIds.includes(workspace.id);
              return <div className="mapping-project" key={workspace.id} data-selected={checked}>
                <label className="mapping-project-choice"><input aria-label={`同步 ${workspace.name}`} type="checkbox" checked={checked} disabled={busy || !editing || (workspace.deleted && !checked)} onChange={event => toggle(workspace.id, event.currentTarget.checked)} />
                  <span><strong>{workspace.name}</strong><small>{workspace.deleted ? "已删除，请取消选择" : "包含此工作区未来新增会话"}</small></span><Badge>Maintenance 真源</Badge>
                </label>
                <div className="mapping-project-detail"><details><summary>工作区详情</summary><p>Maintenance 工作区标识：<code>{workspace.id}</code></p></details></div>
              </div>;
            })}
            {!configuration.workspaces.length ? <EmptyState title="暂无 Maintenance 工作区" description="可单独选择未分组会话；创建工作区后可在此选择。" /> : !visible.length ? <EmptyState title="没有匹配的工作区" description="调整搜索词可查看其他工作区，已有勾选仍然保留。" /> : null}
            {selection.kind === "ids" ? selection.workspaceIds.filter(id => !configuration.workspaces.some(workspace => workspace.id === id)).map(id => <label className="sync-workspace" key={id}><input type="checkbox" disabled={busy || !editing} checked onChange={() => toggle(id, false)} />{id}（已不可用，请取消选择）</label>) : null}
            <label className="sync-workspace"><input type="checkbox" disabled={busy || !editing} checked={selection.kind === "all" || selection.includeUnassigned} onChange={event => { const includeUnassigned = event.currentTarget.checked; setSelection(previous => ({ kind: "ids", workspaceIds: previous.kind === "all" ? configuration.workspaces.filter(workspace => !workspace.deleted).map(workspace => workspace.id) : previous.workspaceIds, includeUnassigned })); }} />包含未分组会话</label>
            {selection.kind === "ids" && !selection.workspaceIds.length && !selection.includeUnassigned ? <p role="status">当前选择为空：下次启动不向此实例同步任何会话。</p> : null}
          </div>
        </fieldset>
        <p className="muted">同一实例的所有配置与已绑定 Vault 共用此范围。所选工作区未来新增的会话也包含在内。取消选择保留历史与链接。</p>
        </div><div className="sync-save-row sync-fixed-actions">
          <span className="muted">{editing ? '编辑同步范围' : configuration.pendingActivation ? '下次启动生效' : '同步范围'}</span>
          {editing ? <><Button disabled={busy} onClick={() => { setSelection(configuration.policy.selection); setEditing(false); setError(undefined); setNotice(undefined); }}>撤销</Button><Button type="submit" tone="primary" disabled={!changed || busy || !api.saveInstanceWorkspaceSync}>{busy ? "正在保存…" : "保存"}</Button></> : <Button onClick={() => setEditing(true)}>编辑</Button>}
        </div>
      </form>
      </details>
    </>}
  </div>;
}
export function InstanceWorkspacePage({ api }: { api: InstanceWorkspaceApi }) {
  const [directory, setDirectory] = useState<InstanceWorkspaceInstanceDirectory>();
  const [instanceId, setInstanceId] = useState("");
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setDirectory(undefined); setError(undefined);
    if (!api.listInstanceWorkspaceInstances) setError("当前维护引擎未提供 DSH 实例同步配置。");
    else void api.listInstanceWorkspaceInstances(controller.signal).then(value => {
      if (!controller.signal.aborted) { setDirectory(value); setInstanceId(current => [...value.instances, ...(value.historicalInstances ?? [])].some(item => item.instanceId === current) ? current : value.instances[0]?.instanceId ?? ""); }
    }, reason => { if (!controller.signal.aborted) setError(message(reason)); });
    return () => controller.abort();
  }, [api, reload]);
  return <Surface title="DSH 实例同步范围" action={<Button onClick={() => setReload(value => value + 1)}>刷新实例</Button>}>
    <div className="settings-content instance-workspace-intro"><p>为每个 DSH 实例选择与真源双向同步的 Maintenance 工作区。保存后在实例下次启动时生效。</p>
      {error ? <p role="alert">{error}</p> : !directory ? <LoadingState label="正在读取 DSH 实例…" /> : !directory.instances.length ? <EmptyState title="没有当前 Launcher 实例" description="在 Launcher 新建实例后刷新此列表。" /> : <label className="field">DSH 实例<select value={directory.instances.some(item => item.instanceId === instanceId) ? instanceId : ""} onChange={event => setInstanceId(event.currentTarget.value)}><option value="" disabled>请选择 Launcher 实例</option>{directory.instances.map(instance => <option key={instance.instanceId} value={instance.instanceId}>{instance.name}{directory.instances.filter(item => item.name === instance.name).length > 1 ? ` · ${instance.instanceId}` : ""}</option>)}</select></label>}
      {directory?.notice ? <p role="status">{directory.notice}</p> : null}
      {directory?.historicalInstances?.length ? <details className="historical-instance-list"><summary>历史及未关联实例（{directory.historicalInstances.length}）</summary><p>这些条目来自历史运行或手工登记，不在当前 Launcher 实例列表中。保留其同步配置和历史记录。</p>{directory.historicalInstances.map(instance => <div key={instance.instanceId}><Button aria-pressed={instanceId === instance.instanceId} onClick={() => setInstanceId(instance.instanceId)}>{instance.name}</Button>{instance.name !== instance.instanceId ? <small>{instance.instanceId}</small> : null}</div>)}</details> : null}
    </div>
    {directory && instanceId && [...directory.instances, ...(directory.historicalInstances ?? [])].some(item => item.instanceId === instanceId) ? <InstanceEditor key={instanceId} api={api} instanceId={instanceId} /> : null}
  </Surface>;
}
