import { useEffect, useRef, useState } from "react";
import type { WorkspaceSyncConfiguration, WorkspaceSyncUpdate } from "@linmu/dsh-session-contracts";
import { Badge, Button, EmptyState, LoadingState, Surface } from "@linmu/dsh-session-ui";

export interface WorkspaceSyncApi {
  getWorkspaceSync?(signal?: AbortSignal): Promise<WorkspaceSyncConfiguration>;
  saveWorkspaceSync?(input: WorkspaceSyncUpdate, signal?: AbortSignal): Promise<WorkspaceSyncConfiguration>;
}
export function SyncPage({ api }: { readonly api: WorkspaceSyncApi }) {
  const [configuration, setConfiguration] = useState<WorkspaceSyncConfiguration>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    setError(undefined); setConfiguration(undefined); setNotice(undefined); setBusy(false);
    if (api.getWorkspaceSync === undefined) setError("当前维护引擎未提供工作区同步配置，请更新后重试。");
    else void api.getWorkspaceSync(controller.signal).then((value) => {
      if (!controller.signal.aborted) { setConfiguration(value); setSelected(new Set(value.policy.workspaceIds)); }
    }, (reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法读取同步配置"); });
    return () => controller.abort();
  }, [api, retry]);
  const save = async () => {
    if (configuration === undefined || busy) return;
    if (api.saveWorkspaceSync === undefined) { setError("当前维护引擎未提供保存同步配置的能力。"); return; }
    const signal = lifetime.current?.signal;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const value = await api.saveWorkspaceSync({ revision: configuration.policy.revision, workspaceIds: [...selected] }, signal);
      if (!signal?.aborted) {
        setConfiguration(value); setSelected(new Set(value.policy.workspaceIds));
        setNotice("配置已保存，包含所选工作区未来新增的会话。Codex 原生回写尚未生效。");
      }
    } catch (reason) { if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "保存失败，请重新读取配置后再试"); }
    finally { if (!signal?.aborted) setBusy(false); }
  };
  const toggle = (id: string, checked: boolean) => {
    setSelected((current) => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; });
    setNotice(undefined);
  };
  const missing = configuration?.policy.workspaceIds.filter((id) => !configuration.workspaces.some((workspace) => workspace.id === id)) ?? [];
  const changed = configuration !== undefined && (selected.size !== configuration.policy.workspaceIds.length || configuration.policy.workspaceIds.some((id) => !selected.has(id)));
  return <>
    <div className="dsm-page-heading"><div><h2>同步</h2><p>选择纳入同步范围的工作区，统一包含其中现有与未来新增的会话。</p></div><Badge tone="warning">原生回写尚未启用</Badge></div>
    <Surface title="工作区同步范围" action={<Button disabled={busy} onClick={() => setRetry((value) => value + 1)}>重新读取</Button>}>
      <div className="settings-content">
        <p>这里只保存工作区名单。是否能够回写由接入能力检查决定。</p>
        {error === undefined ? null : <p role="alert" className="inline-error">{error}</p>}
        {notice === undefined ? null : <p role="status">{notice}</p>}
        {configuration === undefined ? error === undefined ? <LoadingState label="正在读取同步范围…" /> : null : <>
          <p className="capability-notice">{configuration.nativeSyncReason}</p>
          {configuration.workspaces.length === 0 ? <EmptyState title="还没有工作区" description="导入或创建工作区后，可以在这里选择同步范围。" /> : <div className="sync-workspaces">{configuration.workspaces.map((workspace) => <label key={workspace.id} className="sync-workspace" data-selected={selected.has(workspace.id)}>
            <input type="checkbox" checked={selected.has(workspace.id)} disabled={busy || (!workspace.eligible && !selected.has(workspace.id))} onChange={(event) => toggle(workspace.id, event.target.checked)} />
            <span><strong>{workspace.name}</strong><small>{workspace.sessionCount} 个现有会话 · 包含未来新增会话</small><span>{workspace.reason}</span>{workspace.roots.length === 0 ? null : <small className="workspace-roots">{workspace.roots.join("、")}</small>}</span>
            <Badge>{workspace.eligible ? "可选" : "暂不可用"}</Badge>
          </label>)}</div>}
          {missing.length === 0 ? null : <div><p>以下已保存的工作区目前不可见，可取消选择后保存：</p>{missing.map((id) => <label key={id}><input type="checkbox" disabled={busy} checked={selected.has(id)} onChange={(event) => toggle(id, event.target.checked)} /> {id}</label>)}</div>}
          <div className="sync-save-row"><Button tone="primary" disabled={busy || !changed || api.saveWorkspaceSync === undefined} onClick={() => void save()}>{busy ? "正在保存…" : "保存同步范围"}</Button><span className="muted">{selected.size} 个工作区{changed ? " · 有未保存的更改" : " · 与已保存配置一致"}</span></div>
          <p className="muted">保存名单不会启动 Codex 原生同步，也不会改写当前对话。</p>
          {api.saveWorkspaceSync === undefined ? <p role="alert">当前维护引擎未提供保存同步配置的能力。</p> : null}
        </>}
      </div>
    </Surface>
  </>;
}
