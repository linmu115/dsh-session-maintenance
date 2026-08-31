import { useEffect, useState } from "react";

import type { RunCenterItem } from "@linmu/dsh-session-contracts";
import { Badge, EmptyState, LoadingState, Surface, statusTone } from "@linmu/dsh-session-ui";

export interface RunCenterApi { listProjectionRuns(signal?: AbortSignal): Promise<readonly RunCenterItem[]> }

const stages = ["run.lease", "projection.materialize", "runtime.persistence.attach", "session.append.commit", "session.derivation.create", "projection.cross-version.verify", "reference.roundtrip.verify", "run.shutdown-recovery"] as const;

export function RunCenterPage(props: { readonly api: RunCenterApi }) {
  const [runs, setRuns] = useState<readonly RunCenterItem[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void props.api.listProjectionRuns(controller.signal).then(setRuns, (reason: unknown) => setError(reason instanceof Error ? reason.message : "运行中心不可用"));
    return () => controller.abort();
  }, [props.api]);
  if (error !== undefined) return <Surface><EmptyState kind="warning" title="运行中心不可用" description={error} /></Surface>;
  if (runs === undefined) return <Surface><LoadingState label="正在读取运行、租约和断点…" /></Surface>;
  return <>
    <div className="dsm-page-heading"><div><h2>运行中心</h2><p>查看租约、投影、待提交操作、适配器和 P1–P8 状态入口。</p></div></div>
    {runs.length === 0 ? <Surface><EmptyState title="还没有投影运行" description="Launcher 启动受管 DSH 实例后会生成运行记录。" /></Surface> : runs.map((item) => <Surface key={item.run.id} title={`${item.run.profileId} · ${item.run.dshVersion}`}>
      <div className="run-center-summary" data-testid={`run-center-${item.run.id}`}><Badge tone={statusTone(item.run.state)}>{item.run.state}</Badge><code>{item.run.id}</code><span>{item.projectedSessions} 个投影会话</span><span>{item.pendingOperations} 项待提交</span><span>Adapter {item.run.adapterId}</span></div>
      <div className="run-stage-grid">{stages.map((stage, index) => {
        const state = item.latestStages[stage];
        return <article key={stage} data-testid={`run-stage-${index + 1}`} data-state={state?.state ?? "not-started"}><strong>P{index + 1}</strong><code>{stage}</code><Badge tone={state?.state === "failed" ? "danger" : state?.state === "succeeded" ? "success" : "neutral"}>{state?.state ?? "未开始"}</Badge>{state?.errorCode === null || state?.errorCode === undefined ? null : <small>{state.errorCode}</small>}</article>;
      })}</div>
    </Surface>)}
  </>;
}
