import { useEffect, useRef, useState } from "react";
import type { CodexProjectMappingConfiguration, CodexProjectMappingUpdate, WorkspaceSyncConfiguration, WorkspaceSyncUpdate } from "@linmu/dsh-session-contracts";
import { Badge, Button, EmptyState, LoadingState, Surface } from "@linmu/dsh-session-ui";

export interface WorkspaceSyncApi {
  getCodexProjectMapping?(signal?: AbortSignal): Promise<CodexProjectMappingConfiguration>;
  saveCodexProjectMapping?(input: CodexProjectMappingUpdate, signal?: AbortSignal): Promise<CodexProjectMappingConfiguration>;
  getWorkspaceSync?(signal?: AbortSignal): Promise<WorkspaceSyncConfiguration>;
  saveWorkspaceSync?(input: WorkspaceSyncUpdate, signal?: AbortSignal): Promise<WorkspaceSyncConfiguration>;
}
export function NativeWorkspaceSyncPage({ api }: { readonly api: WorkspaceSyncApi }) {
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
    <div className="dsm-page-heading"><div><h2>历史工作区原生回写配置</h2><p>此高级配置独立于 Codex 项目映射名单。</p></div><Badge tone="warning">原生回写尚未启用</Badge></div>
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

function mappingError(reason: unknown, fallback: string): string {
  const message = reason instanceof Error ? reason.message : fallback;
  if (/CONFLICT|STALE|HTTP 409|版本冲突/iu.test(message)) return "映射名单已被其他窗口更新。请刷新目录，重新核对勾选后再保存。";
  if (/NOT_FOUND|HTTP 404|HTTP 501/iu.test(message)) return "当前维护引擎未提供 Codex 项目映射功能，请更新引擎后重试。";
  return message;
}

export function SyncPage({ api }: { readonly api: WorkspaceSyncApi }) {
  const [configuration, setConfiguration] = useState<CodexProjectMappingConfiguration>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [advanced, setAdvanced] = useState(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    setError(undefined); setConfiguration(undefined); setNotice(undefined); setBusy(false);
    if (api.getCodexProjectMapping === undefined) setError("当前维护引擎未提供 Codex 项目映射功能，请更新引擎后重试。");
    else void api.getCodexProjectMapping(controller.signal).then((value) => {
      if (!controller.signal.aborted) { setConfiguration(value); setSelected(new Set(value.policy.projectKeys)); }
    }, (reason: unknown) => { if (!controller.signal.aborted) setError(mappingError(reason, "无法读取项目目录，请刷新重试。")); });
    return () => controller.abort();
  }, [api, retry]);
  const draftChanged = configuration !== undefined && (selected.size !== configuration.policy.projectKeys.length || configuration.policy.projectKeys.some((key) => !selected.has(key)));
  const changed = configuration !== undefined && (!configuration.policy.configured || draftChanged);
  const save = async () => {
    if (configuration === undefined || busy || api.saveCodexProjectMapping === undefined) return;
    const signal = lifetime.current?.signal;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const value = await api.saveCodexProjectMapping({ revision: configuration.policy.revision, projectKeys: [...selected] }, signal);
      if (!signal?.aborted) {
        setConfiguration(value); setSelected(new Set(value.policy.projectKeys));
        setNotice(value.pendingActivation ? "最新映射名单已保存，将在下次启动 DSH 实例时生效。当前活跃名单保持不变。" : "最新映射名单已保存，与当前活跃名单一致。");
      }
    } catch (reason) { if (!signal?.aborted) setError(mappingError(reason, "保存失败，勾选已保留，请重试。")); }
    finally { if (!signal?.aborted) setBusy(false); }
  };
  const toggle = (key: string, checked: boolean) => {
    setSelected((current) => { const next = new Set(current); if (checked) next.add(key); else next.delete(key); return next; });
    setNotice(undefined);
  };
  const nameFor = (key: string) => {
    const project = configuration?.projects.find((item) => item.key === key);
    if (project === undefined) return "目录中暂不可见";
    const sameName = configuration!.projects.filter((item) => item.name === project.name).map((item) => item.key).sort();
    return sameName.length === 1 ? project.name : `${project.name}（${sameName.indexOf(key) + 1}）`;
  };
  const scope = (configured: boolean, keys: readonly string[]) => !configured ? <p>未配置</p> : keys.length === 0 ? <p>不映射任何项目</p> : <ul>{keys.map((key) => <li key={key}>{nameFor(key)}{configuration?.projects.some((project) => project.key === key) ? null : <details><summary>项目详情</summary><code>{key}</code></details>}</li>)}</ul>;
  const visible = configuration?.projects.filter((project) => `${project.name} ${project.instanceId} ${project.projectId} ${project.key}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
  const missing = configuration?.policy.projectKeys.filter((key) => !configuration.projects.some((project) => project.key === key)) ?? [];
  return <>
    <div className="dsm-page-heading"><div><h2>Codex 项目映射</h2><p>按 Codex 侧栏中的项目会话文件夹选择映射范围，包含所选项目未来新增的本地会话。</p></div><Badge>{configuration?.pendingActivation ? "已保存 · 待下次启动 DSH 实例生效" : "映射到 Maintenance"}</Badge></div>
    <Surface title="项目映射名单" action={<Button disabled={busy} onClick={() => setRetry((value) => value + 1)}>刷新目录</Button>}>
      <div className="settings-content">
        <p>保存后，下次启动 DSH 实例 将按最新名单映射。未选项目的会话会从 Maintenance 移除，并保留恢复点；Codex 源会话不会删除。</p>
        <p className="muted">项目归属取自 Codex 的项目会话文件夹。项目根路径仅用于查看详情，不用于按工作目录（cwd）推断归属。</p>
        {error === undefined ? null : <p role="alert" className="inline-error">{error}</p>}
        {notice === undefined ? null : <p role="status">{notice}</p>}
        {configuration === undefined ? error === undefined ? <LoadingState label="正在读取 Codex 项目目录…" /> : null : <>
          <div className="mapping-policy-status">
            <section aria-label="当前活跃名单"><h3>当前活跃名单</h3>{scope(configuration.policy.activeConfigured, configuration.policy.activeProjectKeys)}<small>本次运行采用的名单 · 版本 {configuration.policy.activeRevision}</small></section>
            <section aria-label="最新已保存名单"><h3>最新已保存名单</h3>{scope(configuration.policy.configured, configuration.policy.projectKeys)}<small>{configuration.pendingActivation ? "下次启动 DSH 实例 生效" : configuration.policy.configured ? "与当前活跃配置一致" : "保存后将在下次启动 DSH 实例生效"} · 版本 {configuration.policy.revision}</small></section>
          </div>
          <section className="mapping-observer" aria-label="项目映射观察器状态">
            <strong>项目映射状态：{{ stopped: "未运行", idle: "等待本地会话变化", syncing: "正在更新映射", error: "更新遇到问题" }[configuration.observer.state]}</strong>
            <p className="muted">{configuration.observer.lastSyncAt === null ? "尚无成功更新记录" : `最近成功更新：${configuration.observer.lastSyncAt}`}</p>
            {configuration.observer.lastError === null ? null : <p role="alert" className="inline-error">上次映射更新未完成：{configuration.observer.lastError}。可刷新目录查看最新状态；仍可编辑并保存下次启动 DSH 实例采用的名单。</p>}
          </section>
          {configuration.issues.length === 0 ? null : <div className="capability-notice"><strong>目录提示</strong><ul>{configuration.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></div>}
          <label className="workspace-search"><input aria-label="搜索 Codex 项目" type="search" placeholder="搜索项目名称或项目标识" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <p className="muted">目录共 {configuration.projects.length} 个项目，当前显示 {visible.length} 个。同名项目用编号区分，展开项目详情可核对来源及项目标识。搜索不会改变勾选。刷新目录会取消未保存更改并重新读取已保存名单。</p>
          {configuration.projects.length === 0 ? <EmptyState title="暂未发现 Codex 项目" description="请检查 Codex 本地接入和项目目录后刷新；也可以保存空名单，明确不映射任何项目。" /> : visible.length === 0 ? <EmptyState title="没有匹配的项目" description="调整搜索词可查看其他项目，已有勾选仍然保留。" /> : <div className="sync-workspaces">{visible.map((project) => <div key={project.key} className="mapping-project" data-selected={selected.has(project.key)}>
            <label className="mapping-project-choice">
              <input aria-label={`映射 ${project.name} (${project.instanceId} / ${project.projectId})`} type="checkbox" checked={selected.has(project.key)} disabled={busy || (!project.eligible && !selected.has(project.key))} onChange={(event) => toggle(project.key, event.target.checked)} />
              <span><strong>{nameFor(project.key)}</strong><small>{project.sessionCount} 个现有本地会话 · 包含未来新增本地会话</small></span>
              <Badge>{project.kind === "mixed" ? "混合项目 · 仅本地会话" : project.eligible ? "本地项目" : "暂不可选"}</Badge>
            </label>
            <div className="mapping-project-detail">
              <small>当前活跃：{!configuration.policy.activeConfigured ? "未配置" : configuration.policy.activeProjectKeys.includes(project.key) ? "已映射" : "未映射"} · 最新已保存：{!configuration.policy.configured ? "未配置" : configuration.policy.projectKeys.includes(project.key) ? "已选" : "未选"}</small>
              {project.issues.length === 0 ? null : <ul>{project.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
              <details><summary>项目详情</summary><p>来源实例：{project.instanceId}</p><p>Codex 项目标识：{project.projectId}</p><p>稳定项目标识：<code>{project.key}</code></p><p>项目根路径（仅供查看）：{project.roots.length === 0 ? "未提供" : project.roots.join("、")}</p></details>
            </div>
          </div>)}</div>}
          {missing.length === 0 ? null : <div className="mapping-missing"><p>以下已保存项目暂不在目录中；可保留勾选，或取消后保存：</p>{missing.map((key, index) => <div key={key}><label><input type="checkbox" disabled={busy} checked={selected.has(key)} onChange={(event) => toggle(key, event.target.checked)} /> 暂不可见的已保存项目（{index + 1}）</label><details><summary>项目详情</summary><code>{key}</code></details></div>)}</div>}
          <div className="sync-save-row"><Button tone="primary" disabled={busy || !changed || api.saveCodexProjectMapping === undefined} onClick={() => void save()}>{busy ? "正在保存…" : "保存为最新映射名单"}</Button><Button disabled={busy || !draftChanged} onClick={() => { setSelected(new Set(configuration.policy.projectKeys)); setError(undefined); setNotice(undefined); }}>取消更改</Button><span className="muted">{selected.size === 0 ? "未勾选项目：保存后不映射任何项目" : `已勾选 ${selected.size} 个项目`}{changed ? " · 尚未保存" : " · 与已保存名单一致"}</span></div>
          {api.saveCodexProjectMapping === undefined ? <p role="alert">当前维护引擎未提供保存项目映射名单的能力，请更新引擎。</p> : null}
        </>}
      </div>
    </Surface>
    <details className="mapping-advanced" onToggle={(event) => setAdvanced(event.currentTarget.open)}><summary>高级：历史工作区原生回写配置</summary>{advanced ? <NativeWorkspaceSyncPage api={api} /> : null}</details>
  </>;
}
