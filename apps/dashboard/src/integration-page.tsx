import { useEffect, useRef, useState } from "react";
import type { IntegrationAction, IntegrationDirectory, SelectInstanceFolderResponse } from "@linmu/dsh-session-contracts";
import { INSTANCE_FOLDER_HINT } from "@linmu/dsh-session-contracts";
import { Badge, Button, EmptyState, LoadingState, Surface } from "@linmu/dsh-session-ui";

export interface IntegrationApi {
  listIntegrations?(signal?: AbortSignal): Promise<IntegrationDirectory>;
  integrationAction?(targetId: string, action: IntegrationAction, signal?: AbortSignal): Promise<IntegrationDirectory>;
  selectInstanceFolder?(signal?: AbortSignal): Promise<SelectInstanceFolderResponse>;
  confirmInstanceFolder?(input: { readonly pendingId: string; readonly profileId: string }, signal?: AbortSignal): Promise<IntegrationDirectory>;
}
const targetLabels = { available: "可接入", connected: "已接入", "needs-attention": "需要处理", unsupported: "暂不支持" };
const capabilityLabels = { supported: "可用", unavailable: "不可用", unchecked: "尚未检查" };
/** Where a card came from, so a folder connection is not confused with a Launcher one. */
const sourceLabels = { directory: "来源：实例文件夹", launcher: "来源：Launcher", legacy: "来源：旧记录（未标注来源）" };

/**
 * The folder connection bar. The hint is what tells the operator which level to
 * pick: a profile folder cannot distinguish the profiles inside one Home, so the
 * Home root is the unit of choice and each of its profiles becomes its own
 * connection scope.
 *
 * Checking and connecting are two separate, clearly labelled steps: the check
 * writes nothing, and the per-profile button is what registers the instance.
 */
function InstanceFolderBar(props: {
  readonly api: IntegrationApi;
  readonly signal: AbortSignal | undefined;
  readonly onRegistered: (directory: IntegrationDirectory) => void;
}) {
  const [selection, setSelection] = useState<SelectInstanceFolderResponse>();
  const [error, setError] = useState<string>();
  const [registered, setRegistered] = useState<string>();
  const [busy, setBusy] = useState(false);
  const choose = async () => {
    if (busy || props.api.selectInstanceFolder === undefined) return;
    setBusy(true); setError(undefined); setRegistered(undefined);
    try { setSelection(await props.api.selectInstanceFolder(props.signal)); }
    catch (reason) { if (!props.signal?.aborted) setError(reason instanceof Error ? reason.message : "无法打开文件夹选择框"); }
    finally { setBusy(false); }
  };
  const confirm = async (pendingId: string, profileId: string) => {
    if (busy || props.api.confirmInstanceFolder === undefined) return;
    setBusy(true); setError(undefined);
    try {
      const directory = await props.api.confirmInstanceFolder({ pendingId, profileId }, props.signal);
      setRegistered(profileId);
      props.onRegistered(directory);
    } catch (reason) {
      if (!props.signal?.aborted) setError(reason instanceof Error ? reason.message : "登记这个实例失败");
    } finally { setBusy(false); }
  };
  // An older Engine cannot offer this entry at all; the page already reports
  // missing capabilities, so this bar stays out of the way instead of adding a
  // second, contradictory alert.
  if (props.api.selectInstanceFolder === undefined) return null;
  // The hint is the same text the Engine answers with, so the selection bar can
  // show it before any choice and never drifts from the contract.
  const hint = selection?.hint ?? INSTANCE_FOLDER_HINT;
  const inspection = selection?.cancelled === false ? selection.inspection : undefined;
  const pendingId = selection?.cancelled === false ? selection.pendingId : undefined;
  return <section className="instance-folder-selection" aria-label="按文件夹接入实例">
    <p className="muted">{hint}</p>
    <div className="dsm-action-row">
      <Button tone="primary" disabled={busy} onClick={() => void choose()}>{busy ? "正在选择文件夹…" : "选择实例文件夹…"}</Button>
      {selection === undefined ? null : <Button disabled={busy} onClick={() => { setSelection(undefined); setError(undefined); setRegistered(undefined); }}>清除选择</Button>}
    </div>
    {error === undefined ? null : <p role="alert" className="inline-error">{error}</p>}
    {selection === undefined ? null : selection.cancelled ? <p role="status" className="muted">已取消选择，未接入任何实例。</p> : inspection === undefined ? null : <div className="instance-folder-result">
      <p><strong>{inspection.suggestedInstanceId}</strong> · DSH {inspection.runtimeVersion}</p>
      <p className="muted">{inspection.homeRoot}</p>
      <p>识别到 {inspection.profiles.length} 个配置：{inspection.profiles.map(profile => `${profile.profileId}${profile.web ? "（Web）" : ""}`).join("、")}</p>
      {(inspection.skippedEntries ?? []).length === 0 ? null : <p className="muted">已跳过 {inspection.skippedEntries!.length} 个目录：
        {inspection.skippedEntries!.map(item => `${item.entry}（${item.reason}）`).join("；")}</p>}
      {inspection.versionRoot === null ? <p role="status" className="muted">这个 Home 只声明了版本，未找到已安装的官方程序；接入前需要先安装该实例。</p> : null}
      {registered === undefined ? <p className="muted">以上只是检查结果：<strong>还没有登记任何接入</strong>，也没有写入启动门。确认下面的配置后才算接入。</p>
        : <p role="status">已登记配置 <strong>{registered}</strong>，请查看下方实例列表；检查这一步本身不会写入启动门。</p>}
      {pendingId === undefined || props.api.confirmInstanceFolder === undefined || registered !== undefined ? null : <div className="dsm-action-row">
        {inspection.profiles.map(profile => <Button key={profile.profileId} tone="primary" disabled={busy}
          onClick={() => void confirm(pendingId, profile.profileId)}>接入此实例（{profile.profileId}）</Button>)}
      </div>}
    </div>}
  </section>;
}

export function IntegrationPage({ api }: { readonly api: IntegrationApi }) {
  const [directory, setDirectory] = useState<IntegrationDirectory>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [retry, setRetry] = useState(0);
  // The folder bar outlives the discovery request, so it gets the page's own
  // cancellation signal instead of the per-request one.
  const [lifetimeSignal, setLifetimeSignal] = useState<AbortSignal>();
  const lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller; setLifetimeSignal(controller.signal);
    setError(undefined); setDirectory(undefined); setNotice(undefined); setBusy(false);
    if (api.listIntegrations === undefined) setError("当前维护引擎未提供接入管理，请更新后重新打开看板。");
    else void api.listIntegrations(controller.signal).then((value) => { if (!controller.signal.aborted) setDirectory(value); }, (reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法检查本机接入"); });
    return () => controller.abort();
  }, [api, retry]);
  const act = async (targetId: string, action: IntegrationAction) => {
    if (busy) return;
    if (api.integrationAction === undefined) { setError("当前维护引擎未提供接入操作，请更新后重试。"); return; }
    const signal = lifetime.current?.signal;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const result = await api.integrationAction(targetId, action, signal);
      if (!signal?.aborted) { setDirectory(result); setNotice(action === "disconnect" ? "断开请求已处理，请查看下方接入状态。" : "检查已完成，请查看下方能力与待处理项。"); }
    } catch (reason) { if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "接入操作失败"); }
    finally { if (!signal?.aborted) setBusy(false); }
  };
  return <Surface title="接入管理" action={<Button disabled={busy} onClick={() => setRetry((value) => value + 1)}>重新发现</Button>}>
    <div className="settings-content">
      <p>发现本机 DSH 与 Codex，检查当前版本能提供哪些能力。</p>
      <details><summary>添加实例</summary><InstanceFolderBar key={retry} api={api} signal={lifetimeSignal} onRegistered={(next) => { setDirectory(next); setNotice("已登记为实例文件夹连接；没有写入启动门，实例照常启动。"); }} /></details>
      {error === undefined ? null : <p role="alert" className="inline-error">{error}</p>}
      {notice === undefined ? null : <p role="status">{notice}</p>}
      {directory === undefined ? error === undefined ? <LoadingState label="正在发现本机应用…" /> : null : <>


        {directory.targets.length === 0 ? <EmptyState title="没有发现可接入的应用" description="安装或打开 DSH、Codex 后，使用“重新发现”再次检查。" /> : <div className="integration-list">{directory.targets.map((target) => <article className="integration-card" key={target.id}>
          <header><div><h3>{target.name}</h3><p>{target.kind === "dsh" ? "DSH" : "Codex"} · {target.version || "版本未知"}{target.profile === null ? "" : ` · ${target.profile}`}</p></div><Badge tone={target.status === "connected" ? "success" : target.status === "needs-attention" ? "warning" : "neutral"}>{targetLabels[target.status]}</Badge></header>
          {target.connectionKind === undefined ? null : <p className="muted">{sourceLabels[target.connectionKind]}</p>}
          <details><summary>能力详情</summary><ul className="capability-list">{target.capabilities.map((capability) => <li key={capability.id}><strong>{capability.label}</strong><Badge tone={capability.status === "supported" ? "success" : "neutral"}>{capabilityLabels[capability.status]}</Badge><p>{capability.detail}</p></li>)}</ul></details>
          {target.issues.length === 0 ? null : <div><strong>需要处理</strong><ul>{target.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></div>}
          <div className="dsm-action-row">
            {target.status === "available" ? <Button tone="primary" disabled={busy || api.integrationAction === undefined} onClick={() => void act(target.id, "connect")}>接入并检查</Button> : null}

            {target.status === "needs-attention" ? <Button disabled={busy || api.integrationAction === undefined} onClick={() => void act(target.id, "repair")}>修复</Button> : null}

          </div>
          <details><summary>更多操作与标识</summary><div className="dsm-action-row"><Button disabled={busy || api.integrationAction === undefined} onClick={() => void act(target.id, "check")}>重新检查</Button>{target.status === "connected" || target.status === "needs-attention" ? <Button disabled={busy || api.integrationAction === undefined} onClick={() => void act(target.id, "disconnect")}>断开</Button> : null}</div><p>{target.id}</p><p>适配器：{target.adapterId ?? "尚未匹配"}</p></details>
        </article>)}</div>}
        {api.integrationAction === undefined ? <p role="alert">当前维护引擎未提供接入操作。</p> : null}
      </>}
    </div>
  </Surface>;
}
