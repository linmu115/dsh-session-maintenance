import { useEffect, useState } from "react";

import type { RunCenterItem } from "@linmu/dsh-session-contracts";
import { Badge, EmptyState, LoadingState, Surface, statusTone } from "@linmu/dsh-session-ui";
import { RUN_STATE_LABELS, runtimeWritebackLabel } from "./maintenance-status.js";
import { ImportJobsPanel, type ImportJobsApi } from "./import-jobs.js";

export interface RunCenterApi extends ImportJobsApi { listProjectionRuns(signal?: AbortSignal): Promise<readonly RunCenterItem[]> }

const stages = [
  ["run.lease", "取得运行权限"], ["projection.materialize", "准备会话投影"],
  ["projection.delta-apply", "更新投影变动"], ["runtime.persistence.attach", "连接运行实例"],
  ["session.append.commit", "保存运行变动"], ["session.derivation.create", "创建继续会话"],
  ["projection.cross-version.verify", "核对投影内容"], ["projection.cache-retained", "保留可复用缓存"],
  ["reference.index", "更新引用索引"], ["reference.roundtrip.verify", "核对双向引用"],
  ["run.shutdown-recovery", "收尾与恢复"],
] as const;

export function RunCenterPage(props: { readonly api: RunCenterApi }) {
  const [runs, setRuns] = useState<readonly RunCenterItem[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void props.api.listProjectionRuns(controller.signal).then(
      (value) => { if (!controller.signal.aborted) setRuns(value); },
      (reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "运行中心不可用"); },
    );
    return () => controller.abort();
  }, [props.api]);
  return <>
    <div className="dsm-page-heading"><div><h2>运行中心</h2><p>分别查看启动时的投影准备和运行中的变动保存情况。</p></div></div>
    <ImportJobsPanel api={props.api} />
    {error !== undefined ? <Surface><EmptyState kind="warning" title="投影运行记录暂时不可用" description={error} /></Surface>
      : runs === undefined ? <Surface><LoadingState label="正在读取运行、租约和断点…" /></Surface>
        : runs.length === 0 ? <Surface><EmptyState title="还没有投影运行" description="Launcher 启动受管 DSH 实例后会生成运行记录。" /></Surface> : runs.map((item) => <Surface key={item.run.id} title={`${item.run.profileId} · ${item.run.dshVersion}`}>
      <div className="run-center-summary" data-testid={`run-center-${item.run.id}`}><Badge tone={statusTone(item.run.state)}>{RUN_STATE_LABELS[item.run.state]}</Badge><span>{item.projectedSessions} 个投影会话</span><span>{item.pendingOperations} 项待提交</span></div>
      <p role="status">{runtimeWritebackLabel(item.run, item.pendingOperations)}</p>
      <div className="run-stage-grid">{stages.map(([stage, label], index) => {
        const state = item.latestStages[stage];
        return <article key={stage} data-testid={`run-stage-${index + 1}`} data-state={state?.state ?? "not-started"}><strong>{label}</strong><Badge tone={state?.state === "failed" ? "danger" : state?.state === "succeeded" ? "success" : "neutral"}>{state?.state === "failed" ? "失败" : state?.state === "succeeded" ? "完成" : state?.state === "started" ? "处理中" : "未开始"}</Badge>{state?.errorCode === null || state?.errorCode === undefined ? null : <small>{state.errorCode}</small>}</article>;
      })}</div>
      <details><summary>运行技术信息</summary><p>运行 <code>{item.run.id}</code> · Adapter <code>{item.run.adapterId}</code></p></details>
    </Surface>)}
  </>;
}
