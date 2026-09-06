import { useEffect, useRef, useState } from "react";
import type { IntegrationAction, IntegrationDirectory } from "@linmu/dsh-session-contracts";
import { Badge, Button, EmptyState, LoadingState, Surface } from "@linmu/dsh-session-ui";

export interface IntegrationApi {
  listIntegrations?(signal?: AbortSignal): Promise<IntegrationDirectory>;
  integrationAction?(targetId: string, action: IntegrationAction, signal?: AbortSignal): Promise<IntegrationDirectory>;
}
const targetLabels = { available: "可接入", connected: "已接入", "needs-attention": "需要处理", unsupported: "暂不支持" };
const capabilityLabels = { supported: "可用", unavailable: "不可用", unchecked: "尚未检查" };
export function IntegrationPage({ api }: { readonly api: IntegrationApi }) {
  const [directory, setDirectory] = useState<IntegrationDirectory>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [retry, setRetry] = useState(0);
  const lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
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
      {error === undefined ? null : <p role="alert" className="inline-error">{error}</p>}
      {notice === undefined ? null : <p role="status">{notice}</p>}
      {directory === undefined ? error === undefined ? <LoadingState label="正在发现本机应用…" /> : null : <>
        <p className="capability-notice">{directory.nativeSyncReason}</p>
        {directory.launcherDetected ? <p className="muted">已发现本机启动入口。</p> : <p className="muted">尚未发现本机启动入口；接入检查会列出需要处理的项目。</p>}
        {directory.targets.length === 0 ? <EmptyState title="没有发现可接入的应用" description="安装或打开 DSH、Codex 后，使用“重新发现”再次检查。" /> : <div className="integration-list">{directory.targets.map((target) => <article className="integration-card" key={target.id}>
          <header><div><h3>{target.name}</h3><p>{target.kind === "dsh" ? "DSH" : "Codex"} · {target.version || "版本未知"}{target.profile === null ? "" : ` · ${target.profile}`}</p></div><Badge tone={target.status === "connected" ? "success" : target.status === "needs-attention" ? "warning" : "neutral"}>{targetLabels[target.status]}</Badge></header>
          <ul className="capability-list">{target.capabilities.map((capability) => <li key={capability.id}><strong>{capability.label}</strong><Badge tone={capability.status === "supported" ? "success" : "neutral"}>{capabilityLabels[capability.status]}</Badge><p>{capability.detail}</p></li>)}</ul>
          {target.issues.length === 0 ? null : <div><strong>需要处理</strong><ul>{target.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></div>}
          <div className="dsm-action-row">
            {target.status === "available" ? <Button tone="primary" disabled={busy || api.integrationAction === undefined} onClick={() => void act(target.id, "connect")}>接入并检查</Button> : null}
            <Button disabled={busy || api.integrationAction === undefined} onClick={() => void act(target.id, "check")}>重新检查</Button>
            {target.status === "needs-attention" ? <Button disabled={busy || api.integrationAction === undefined} onClick={() => void act(target.id, "repair")}>修复</Button> : null}
            {target.status === "connected" || target.status === "needs-attention" ? <Button disabled={busy || api.integrationAction === undefined} onClick={() => void act(target.id, "disconnect")}>断开</Button> : null}
          </div>
          <details><summary>接入标识</summary><p>{target.id}</p><p>适配器：{target.adapterId ?? "尚未匹配"}</p></details>
        </article>)}</div>}
        {api.integrationAction === undefined ? <p role="alert">当前维护引擎未提供接入操作。</p> : null}
      </>}
    </div>
  </Surface>;
}
