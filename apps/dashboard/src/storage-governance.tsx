import { useEffect, useRef, useState } from "react";

import type { RetentionBatch, RetentionDiscoveryResult, RetentionPlanItem, RetentionPreviewPlan, RetentionResource, RetentionRegistry, RetentionRoot, RetentionSource } from "@linmu/dsh-session-contracts";
import { Badge, Button, EmptyState, LoadingState, Metric, Surface } from "@linmu/dsh-session-ui";
import { RetentionRegistryPanel } from "./retention-registry.js";

export interface StorageGovernanceApi {
  previewRetention(signal?: AbortSignal): Promise<RetentionPreviewPlan>;
  discoverRetention(signal?: AbortSignal): Promise<RetentionDiscoveryResult>;
  executeRetention(planId: string, signal?: AbortSignal): Promise<RetentionBatch>;
  listRetentionBatches(signal?: AbortSignal): Promise<readonly RetentionBatch[]>;
  restoreRetention(batchId: string, signal?: AbortSignal): Promise<RetentionBatch>;
  purgeRetention(batchId: string, signal?: AbortSignal): Promise<RetentionBatch>;
  verifyRetention(resourceId: string, signal?: AbortSignal): Promise<RetentionResource>;
  getRetentionRegistry(signal?: AbortSignal): Promise<RetentionRegistry>;
  registerRetentionRoot(input: Pick<RetentionRoot, "id" | "path" | "purpose">, signal?: AbortSignal): Promise<RetentionRoot>;
  registerRetentionSource(input: Omit<RetentionSource, "kind" | "retained"> & { kind: "backup-database" | "candidate-database" | "unknown"; retained: true }, signal?: AbortSignal): Promise<RetentionSource>;
  registerFlatRetentionCandidate(sourceId: string, signal?: AbortSignal): Promise<RetentionResource>;
}

export function storageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes < 1024 ** 2 ? "KiB" : bytes < 1024 ** 3 ? "MiB" : "GiB";
  const power = unit === "KiB" ? 1 : unit === "MiB" ? 2 : 3;
  return `${(bytes / 1024 ** power).toFixed(1)} ${unit}`;
}

const REASONS: Readonly<Record<string, string>> = {
  "manually-pinned": "手动固定", "registered-recovery-dependency": "恢复仍需要此副本",
  "run-running": "运行仍在使用", "run-preparing": "投影仍在准备", "run-draining": "运行正在收尾",
  "run-recovering": "恢复正在进行", "run-recovery-required": "需要先完成恢复", "run-quarantined": "隔离运行尚待处理",
  "run-cleanup-pending": "运行收尾仍待核对", "uncommitted-wal": "仍有未提交的写入", "unfinished-operation": "仍有未完成操作",
  "close-checkpoint-unproven": "缺少可验证的收尾记录", "checkpoint-run-dependency": "恢复点需要此运行",
  "retained-run-sparse-base": "保留的运行依赖此缓存", "cache-last-use-unknown": "缓存使用时间未知",
  "backup-validity-unproven": "备份尚未通过完整性验证", "transaction-not-verifiably-finished": "相关事务尚未确认结束",
  "checkpoint-or-recovery-backup": "恢复点或未完成事务需要此备份", "candidate-registration-unproven": "候选库登记不完整",
  "validity-unproven": "完整性证据不足", "trusted-completion-time-unknown": "缺少可信的完成时间",
  "finished-run-retention-window": "尚在运行副本保留期", "cache-capacity-target-or-protection": "缓存未超目标或仍受保护",
  "newest-valid-automatic-backups": "保留最近的有效备份", "incomplete-reference-coverage": "引用清单仍有缺口",
  "verified-governance-eligibility": "已通过治理条件核对", "retained-flat-database": "平铺恢复库需要整组文件治理",
};

export function storageItemLabel(item: RetentionPlanItem): string {
  return ({ run: "运行副本", cache: "可重建缓存", backup: "事务备份", candidate: "候选库", "content-object": "版本正文对象", database: "保留的数据库" } as Readonly<Record<string, string>>)[item.kind] ?? "保留副本";
}
function reasonLabel(reason: string): string { return REASONS[reason] ?? (reason.startsWith("run-") ? "相关运行仍未结束" : reason); }

export function StorageGovernancePage({ api }: { readonly api: StorageGovernanceApi }) {
  const [plan, setPlan] = useState<RetentionPreviewPlan>();
  const [batches, setBatches] = useState<readonly RetentionBatch[]>([]);
  const [registry, setRegistry] = useState<RetentionRegistry>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [approvedPlan, setApprovedPlan] = useState<string>();
  const [purgeReady, setPurgeReady] = useState<string>();
  const lifetime = useRef<AbortController | undefined>(undefined);
  const load = async (signal?: AbortSignal) => {
    const [preview, history, registered] = await Promise.all([api.previewRetention(signal), api.listRetentionBatches(signal), api.getRetentionRegistry(signal)]);
    if (signal?.aborted) return;
    setPlan(preview); setBatches(history); setRegistry(registered); setApprovedPlan(undefined); setPurgeReady(undefined);
  };
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    void load(controller.signal).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法读取存储预览"); });
    return () => controller.abort();
  }, [api]);
  const act = async (operation: (signal?: AbortSignal) => Promise<unknown>, message: string) => {
    if (busy) return;
    const signal = lifetime.current?.signal;
    setBusy(true); setError(undefined); setNotice(undefined);
    try { await operation(signal); await load(signal); if (!signal?.aborted) setNotice(message); }
    catch (reason) {
      // An interrupted move can already have a durable batch. Reload it so
      // recovery controls appear without losing the original failure.
      if (!signal?.aborted) {
        try { await load(signal); } catch { /* Preserve the operation failure. */ }
        if (!signal?.aborted) { setApprovedPlan(undefined); setError(reason instanceof Error ? reason.message : "存储治理操作失败，请重新预览"); }
      }
    }
    finally { if (!signal?.aborted) setBusy(false); }
  };
  const resources = plan?.items.filter((item) => item.kind !== "content-object") ?? [];
  return <>
    <div className="dsm-page-heading"><div><h2>存储空间</h2><p>查看已登记副本的占用、保护原因与可回收空间。所有现有会话版本正文继续保留。</p></div></div>
    <Surface title="回收预览">
      <div className="storage-panel-body">
      <div className="dsm-action-row">
        <Button disabled={busy} onClick={() => void act(async (signal) => { const result = await api.discoverRetention(signal); if (result.unknownPaths.length > 0) throw new Error(`已登记 ${result.registeredResourceIds.length} 项；另有 ${result.unknownPaths.length} 处来源未知，请在登记清单中核对位置。`); }, "已识别有明确来源的运行、缓存和备份。")}>识别已有副本</Button>
        <Button disabled={busy} onClick={() => void act(async () => undefined, "预览已更新。")}>重新预览</Button>
      </div>
      {error === undefined ? null : <p role="alert">{error}</p>}
      {notice === undefined ? null : <p role="status">{notice}</p>}
      {plan === undefined ? error === undefined ? <LoadingState label="正在核对引用与副本…" /> : null : <>
        <div className="dsm-metrics">
          <Metric label="已登记占用" value={storageBytes(plan.items.reduce((sum, item) => sum + item.bytes, 0))} /><Metric label="受保护占用" value={storageBytes(plan.protectedBytes)} />
          <Metric label="可回收副本（先隔离）" value={storageBytes(plan.executableBytes)} />
          <Metric label="孤儿对象预览（仅统计）" value={storageBytes(plan.items.filter((item) => item.kind === "content-object" && item.disposition === "candidate").reduce((sum, item) => sum + item.bytes, 0))} />
          <Metric label="缓存仍超出目标" value={storageBytes(plan.cacheBytesAboveTarget)} />
        </div>
        <p>受保护空间仍被会话、恢复点或未完成操作使用，不能回收。可回收量是当前预览允许隔离的副本；隔离不等于立即释放磁盘空间。统计仅覆盖已登记内容。</p><p>完成运行保留 {plan.policy.finishedRunHours} 小时，完成恢复的证据保留 {plan.policy.recoveredRunHours} 小时；保留最近 {plan.policy.automaticBackupsToKeep} 份有效自动备份。缓存目标 {storageBytes(plan.policy.cacheTargetBytes)}。</p>
        {plan.blockers.length === 0 ? null : <div role="status"><strong>以下证据尚未齐全，当前计划不能执行：</strong><ul>{plan.blockers.map((blocker, index) => <li key={index}><code>{blocker.source}</code>：{blocker.detail}</li>)}</ul></div>}
        {resources.length === 0 ? <EmptyState title="尚无已登记的运行副本或缓存" description="使用“识别已有副本”读取已有来源；未知目录会继续保留。" /> : <div className="storage-table-scroll" role="region" aria-label="副本占用与保护状态" tabIndex={0}><table><thead><tr><th>副本</th><th>占用</th><th>状态与原因</th><th>操作</th></tr></thead><tbody>{resources.map((item) => <tr key={item.id}>
          <td>{storageItemLabel(item)}<details><summary>位置与标识</summary><code>{item.rootId}/{item.relativePath}</code><p>{item.id}</p></details></td>
          <td>{storageBytes(item.bytes)}</td>
          <td><Badge tone={item.disposition === "candidate" ? "info" : "neutral"}>{item.disposition === "candidate" ? "可隔离" : item.disposition === "blocked" ? "等待核查" : "保留"}</Badge> {item.reasons.map(reasonLabel).join("；")}</td>
          <td>{["backup", "candidate"].includes(item.kind) ? <Button disabled={busy} onClick={() => void act((signal) => api.verifyRetention(item.id, signal), "已核对该副本的完整性。")}>验证副本</Button> : null}</td>
        </tr>)}</tbody></table></div>}
        {plan.executableBytes > 0 && plan.blockers.length === 0 ? <div className="storage-approval-row">
          <label><input type="checkbox" checked={approvedPlan === plan.id} onChange={(event) => setApprovedPlan(event.target.checked ? plan.id : undefined)} /> 已核对本次预览的可隔离副本（{storageBytes(plan.executableBytes)}）</label>
          <Button disabled={busy || approvedPlan !== plan.id} onClick={() => void act((signal) => api.executeRetention(plan.id, signal), "副本已进入隔离区，可在宽限期内恢复。")}>隔离本次候选副本</Button>
        </div> : null}
        <p>隔离后的 {plan.policy.quarantineHours} 小时内可以恢复。最终释放需再次核对引用，宽限期到达后仍需手动执行。</p>
      </>}
      </div>
    </Surface>
    {registry === undefined ? null : <RetentionRegistryPanel api={api} registry={registry} busy={busy} act={act} />}
    <Surface title="隔离与恢复记录">
      {batches.length === 0 ? <EmptyState title="还没有执行过副本隔离" description="执行记录、宽限期限和恢复入口会保留在这里。" /> : batches.map((batch) => {
        const restorable = batch.items.some((item) => item.state === "quarantined" || item.state === "planned");
        const releasing = batch.items.some((item) => item.state === "purging");
        const pending = batch.items.some((item) => item.state === "planned");
        const releasable = (restorable || releasing) && Date.parse(batch.purgeAfter) <= Date.now();
        return <article className="storage-batch" key={batch.id}>
          <p>{new Date(batch.createdAt).toLocaleString()} · {batch.items.length} 项副本 · 最早可释放于 {new Date(batch.purgeAfter).toLocaleString()}</p>
          <p>{batch.items.filter((item) => item.state === "restored").length} 项已恢复，{batch.items.filter((item) => item.state === "purged").length} 项已释放。</p>
          {batch.items.filter((item) => item.error !== null).map((item) => <p role="alert" key={item.resourceId}>{item.resourceId}：{item.error}</p>)}
          <Button disabled={busy || !restorable || releasing} onClick={() => void act((signal) => api.restoreRetention(batch.id, signal), "已恢复隔离副本。")}>恢复副本</Button>
          {pending ? <Button disabled={busy} onClick={() => void act((signal) => api.executeRetention(batch.plan.id, signal), "已继续处理未完成的隔离批次。")}>继续隔离</Button> : null}
          {releasing ? <p role="status">上次释放尚未完成；已释放的文件无法恢复。可重新核对并继续释放。</p> : null}
          {releasable ? <><label><input type="checkbox" checked={purgeReady === batch.id} onChange={(event) => setPurgeReady(event.target.checked ? batch.id : undefined)} /> 确认永久释放这批副本</label><Button disabled={busy || purgeReady !== batch.id} onClick={() => void act((signal) => api.purgeRetention(batch.id, signal), "已完成本批次释放；保留项仍受引用保护。")}>核对并永久释放</Button></> : null}
        </article>;
      })}
    </Surface>
  </>;
}
