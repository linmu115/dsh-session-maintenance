import { useEffect, useState } from "react";
import { Button, Surface, EmptyState, LoadingState, Badge } from "@linmu/dsh-session-ui";
import type { LearningDirectory, LearningBind, LearningBinding } from "@linmu/dsh-session-contracts";
export interface LearningApi {
  learningDirectory(signal?: AbortSignal): Promise<LearningDirectory>;
  bindLearning(input: LearningBind, signal?: AbortSignal): Promise<LearningBinding>;
  learningAction(id: string, action: "send" | "collect" | "disable" | "verifySend" | "revalidate", signal?: AbortSignal): Promise<LearningBinding>;
}
const stateNames: Record<LearningBinding["state"], string> = { ready: "待同步", sending: "正在同步", sent: "等待回收", collected: "已回收", conflict: "存在差异", uncertain: "需要核验", disabled: "已停用" };
export function LearningPage({ api }: { readonly api: LearningApi }) {
  const [directory, setDirectory] = useState<LearningDirectory>();
  const [error, setError] = useState<string>();
  const [errorOwner, setErrorOwner] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [selected, setSelected] = useState("");
  const [targetId, setTargetId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void api.learningDirectory(controller.signal).then(value => { if (!controller.signal.aborted) setDirectory(value); })
      .catch((e: unknown) => { if (!controller.signal.aborted) { setDirectory(undefined); setError(previous => [previous, e instanceof Error ? e.message : "读取失败"].filter(Boolean).join(" ")); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, revision]);
  const perform = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id); setError(undefined); setErrorOwner(id);
    try { await action(); setConfirmed(false); }
    catch (e) { setError(e instanceof Error ? e.message : "操作未完成"); }
    finally { setBusy(undefined); setRevision(v => v + 1); }
  };
  const candidate = directory?.candidates.find(c => `${c.logicalSessionId}:${c.dshRunId}` === selected);
  const target = directory?.targets.find(t => t.id === targetId);
  const bindBlockedReason = candidate?.blockedReason || (candidate && target?.codexInstanceId && target.codexInstanceId !== candidate.codexInstanceId
    ? "所选 Codex 目标与会话来源不一致，请选择对应的目标" : null);
  return <div className="page-stack">
    <div className="dsm-page-heading"><div><h2>学习会话双向维护 <Badge tone="warning">实验</Badge></h2><p>在 DSH 和 Codex 轮流学习，回收新增问答到原会话。</p></div></div>
    <Surface title="使用方式"><div className="settings-content"><p>首次关联、同步和回收前，都要先通过 Launcher 正常停止对应 DSH 实例，等待写入收尾，再刷新状态。同步成功后重新启动 Codex，再继续绑定的任务；回收完成后重新启动 DSH。两端发生差异会阻止追加。</p><p>问答及引用上下文会送入 Codex。Codex 页面可能不显示导入的历史，DSH 完整记录仍会保留。</p></div></Surface>
    {error && (!directory || !errorOwner) ? <p className="inline-error" role="alert">{error}</p> : null}
    <p>学习交接仅保留文字，图片会跳过并显示数量；纯图片消息保留“[图片已跳过]”占位。原会话中的图片不变。</p>
    <p>加入双向维护后，该会话自动退出普通 Codex 项目同步，由学习交接维护。停用关联也不会自动恢复普通同步，以免覆盖学习进度。</p>
    <Surface title="已确认关联的会话" action={<Button disabled={!!busy} onClick={() => { setError(undefined); setRevision(v => v + 1); }}>刷新状态</Button>}>
      {!directory && !error ? <LoadingState label="正在读取学习关联…" /> : null}
      {directory?.bindings.length === 0 ? <EmptyState title="尚未关联学习会话" description="只会加入你明确确认的双端会话，不按标题自动匹配。" /> : null}
      {directory?.bindings.map(binding => <article key={binding.id} className="settings-content" aria-busy={busy === binding.id}>
        <h3>{binding.title} <Badge>{stateNames[binding.state]}</Badge></h3>
        <p role="status">{binding.message}</p>
        {binding.imageNotice ? <p>{binding.imageNotice}</p> : null}
        {binding.blockedReason ? <p>{binding.blockedReason}</p> : null}
        <p>{binding.sentAt ? `上次同步：${new Date(binding.sentAt).toLocaleString()}` : "尚未同步"}{binding.collectedAt ? ` · 上次回收：${new Date(binding.collectedAt).toLocaleString()}` : ""}</p>
        <div className="deleted-session-actions">
          <Button disabled={!!busy || !!binding.blockedReason || !["ready", "collected"].includes(binding.state)} onClick={() => void perform(binding.id, () => api.learningAction(binding.id, "send"))}>同步到 Codex</Button>
          <Button disabled={!!busy || !!binding.blockedReason || binding.state !== "sent"} onClick={() => void perform(binding.id, () => api.learningAction(binding.id, "collect"))}>回收 Codex 会话</Button>
          {["sending", "uncertain"].includes(binding.state) ? <Button disabled={!!busy || !!binding.blockedReason} onClick={() => void perform(binding.id, () => api.learningAction(binding.id, "verifySend"))}>核验同步结果</Button> : null}
          <Button disabled={!!busy || binding.state === "sending"} onClick={() => void perform(binding.id, () => api.learningAction(binding.id, "revalidate"))}>重新核对关联</Button>
          <Button disabled={!!busy || binding.state === "disabled"} onClick={() => void perform(binding.id, () => api.learningAction(binding.id, "disable"))}>停用关联</Button>
        </div>
        {busy === binding.id ? <p role="status">正在处理，请等待本次结果…</p> : null}
        {error && errorOwner === binding.id ? <p className="inline-error" role="alert">{error}</p> : null}
        <details><summary>关联信息</summary><p>DSH：{binding.dshInstanceId} / {binding.dshProfileId}</p><p>Codex：{binding.codexThreadId}</p><p>逻辑会话：{binding.logicalSessionId}</p></details>
      </article>)}
    </Surface>
    <Surface title="确认双端关联"><div className="settings-content">
      <p>从已有来源和 DSH 投影选择同一条学习会话。首次关联会核对共同问答历史，并由 Maintenance 接管这条学习主线。</p>
      <div className="operations-form">
        <label className="field"><span>学习会话</span><select value={selected} disabled={!!busy} onChange={e => { setSelected(e.target.value); setConfirmed(false); }}><option value="">选择已有会话</option>{directory?.candidates.map(c => <option key={`${c.logicalSessionId}:${c.dshRunId}`} value={`${c.logicalSessionId}:${c.dshRunId}`}>{c.title} · {c.dshLabel}</option>)}</select></label>
        <label className="field"><span>已配置的 Codex 目标</span><select value={targetId} disabled={!!busy} onChange={e => { setTargetId(e.target.value); setConfirmed(false); }}><option value="">选择目标</option>{directory?.targets.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
        {directory?.targets.length === 0 ? <p>尚未配置 Codex 目标。请先在 Maintenance 中登记本机 Codex 目标。</p> : null}
        {candidate ? <p>将关联 Codex 任务：{candidate.codexThreadId}</p> : null}
        {bindBlockedReason ? <p role="status">{bindBlockedReason}</p> : null}
        <label className="toggle-field"><input type="checkbox" checked={confirmed} disabled={!!busy || loading || !candidate || !target || !!bindBlockedReason} onChange={e => setConfirmed(e.target.checked)} />我确认两端属于同一条学习会话，由 Maintenance 维护主线</label>
        <Button disabled={!!busy || loading || !candidate || !target || !confirmed || !!bindBlockedReason} onClick={() => { if (candidate) void perform("bind", () => api.bindLearning({ logicalSessionId: candidate.logicalSessionId, codexThreadId: candidate.codexThreadId, dshRunId: candidate.dshRunId, targetPresetId: targetId, confirmed: true })); }}>{busy === "bind" ? "正在核对关联…" : "核对并加入"}</Button>
        {error && directory && errorOwner === "bind" ? <p className="inline-error" role="alert">{error}</p> : null}
      </div></div>
    </Surface>
  </div>;
}
