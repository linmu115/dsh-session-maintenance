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
  const [selection, setSelection] = useState<InstanceWorkspaceSelection>({ kind: "all" });
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [editing, setEditing] = useState(false);
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
    setSelection(previous => previous.kind === "all" ? previous : { ...previous,
      workspaceIds: checked ? [...previous.workspaceIds, id].sort() : previous.workspaceIds.filter(candidate => candidate !== id) });
    setNotice(undefined);
  };
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
      <form ref={editorLayout} className="sync-editor-layout" onSubmit={event => { event.preventDefault(); void save(); }}>
        <div className="sync-editor-scroll"><fieldset className="instance-workspace-selection" disabled={busy || !editing}><legend>此实例下次启动时同步</legend>
          <label className="sync-workspace"><input type="radio" name="instance-selection" checked={selection.kind === "all"} onChange={() => setSelection({ kind: "all" })} />全部工作区及未分组会话</label>
          <label className="sync-workspace"><input type="radio" name="instance-selection" checked={selection.kind === "ids"} onChange={() => setSelection({ kind: "ids", workspaceIds: [], includeUnassigned: false })} />仅同步以下选择</label>
          {selection.kind === "ids" ? <div className="sync-workspaces">
            {configuration.workspaces.map(workspace => <label className="sync-workspace" key={workspace.id} data-selected={selection.workspaceIds.includes(workspace.id)}>
              <input type="checkbox" checked={selection.workspaceIds.includes(workspace.id)} disabled={workspace.deleted && !selection.workspaceIds.includes(workspace.id)} onChange={event => toggle(workspace.id, event.currentTarget.checked)} />
              {workspace.name}{workspace.deleted ? "（已删除，请取消选择）" : ""}
            </label>)}
            {selection.workspaceIds.filter(id => !configuration.workspaces.some(workspace => workspace.id === id)).map(id => <label className="sync-workspace" key={id}><input type="checkbox" checked onChange={() => toggle(id, false)} />{id}（已不可用，请取消选择）</label>)}
            <label className="sync-workspace"><input type="checkbox" checked={selection.includeUnassigned} onChange={event => { const includeUnassigned = event.currentTarget.checked; setSelection(previous => previous.kind === "ids" ? { ...previous, includeUnassigned } : previous); }} />包含未分组会话</label>
            {!selection.workspaceIds.length && !selection.includeUnassigned ? <p role="status">当前选择为空：下次启动不向此实例同步任何会话。</p> : null}
          </div> : null}
        </fieldset>
        <p className="muted">同一实例的所有配置与已绑定 Vault 共用此范围。所选工作区未来新增的会话也包含在内。取消选择保留历史与链接。</p>
        </div><div className="sync-save-row sync-fixed-actions">
          <span className="muted">{editing ? '编辑同步范围' : configuration.pendingActivation ? '下次启动生效' : '同步范围'}</span>
          {editing ? <><Button disabled={busy} onClick={() => { setSelection(configuration.policy.selection); setEditing(false); setError(undefined); setNotice(undefined); }}>撤销</Button><Button type="submit" tone="primary" disabled={!changed || busy || !api.saveInstanceWorkspaceSync}>{busy ? "正在保存…" : "保存"}</Button></> : <Button onClick={() => setEditing(true)}>编辑</Button>}
        </div>
      </form>
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
      if (!controller.signal.aborted) { setDirectory(value); setInstanceId(current => value.instances.some(item => item.instanceId === current) ? current : value.instances[0]?.instanceId ?? ""); }
    }, reason => { if (!controller.signal.aborted) setError(message(reason)); });
    return () => controller.abort();
  }, [api, reload]);
  return <Surface title="DSH 实例同步范围" action={<Button onClick={() => setReload(value => value + 1)}>刷新实例</Button>}>
    <div className="settings-content instance-workspace-intro"><p>为每个 DSH 实例选择与真源双向同步的 Maintenance 工作区。保存后在实例下次启动时生效。</p>
      {error ? <p role="alert">{error}</p> : !directory ? <LoadingState label="正在读取 DSH 实例…" /> : !directory.instances.length ? <EmptyState title="没有可配置的 DSH 实例" description="请先在设置中接入 DSH 实例。" /> : <label className="field">DSH 实例<select value={instanceId} onChange={event => setInstanceId(event.currentTarget.value)}>{directory.instances.map(instance => <option key={instance.instanceId} value={instance.instanceId}>{instance.name}</option>)}</select></label>}
    </div>
    {directory && instanceId && directory.instances.some(item => item.instanceId === instanceId) ? <InstanceEditor key={instanceId} api={api} instanceId={instanceId} /> : null}
  </Surface>;
}
