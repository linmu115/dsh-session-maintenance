import { useEffect, useRef, useState } from "react";

import type { CodexImportRequest, DashboardOverview, JobRef, JobSummary } from "@linmu/dsh-session-contracts";
import { Badge, Button, EmptyState, Surface } from "@linmu/dsh-session-ui";

export interface ImportJobsApi {
  overview(signal?: AbortSignal): Promise<DashboardOverview>;
  listCodexImports(signal?: AbortSignal): Promise<readonly JobSummary[]>;
  importCodex(input: CodexImportRequest, signal?: AbortSignal): Promise<JobRef>;
  cancelCodexImport(id: string, signal?: AbortSignal): Promise<JobRef>;
  resumeCodexImport(id: string, signal?: AbortSignal): Promise<JobRef>;
}

export function importJobPresentation(item: JobSummary): { readonly label: string; readonly detail: string; readonly active: boolean } {
  const event = item.latestEvent;
  const active = item.job.status === "queued" || item.job.status === "running";
  if (event?.type === "failed" && event.code === "JOB_CANCELLED") return { label: "已取消", detail: "已保存的内容保留，重试会重新核对来源并继续。", active: false };
  const labels = { queued: "排队中", running: "正在导入", completed: "导入完成", failed: "导入失败" };
  const detail = event?.type === "progress" ? `已处理 ${event.current} 项${event.total === undefined ? "" : `，共 ${event.total} 项`}`
    : event?.type === "failed" ? event.message
    : item.job.status === "completed" ? "来源观察与保存已完成。" : "等待下一次进度更新。";
  return { label: labels[item.job.status], detail, active };
}

export function ImportJobsPanel({ api }: { readonly api: ImportJobsApi }) {
  const [jobs, setJobs] = useState<readonly JobSummary[]>();
  const [instanceIds, setInstanceIds] = useState<readonly string[]>([]);
  const [mode, setMode] = useState<CodexImportRequest["mode"]>("content");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void api.overview(controller.signal).then((overview) => {
      if (!controller.signal.aborted) setInstanceIds(overview.instances.filter((item) => item.platform === "codex").map((item) => item.id));
    }, (reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法读取导入来源"); });
    return () => controller.abort();
  }, [api]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      let delay = 15000;
      try {
        const items = await api.listCodexImports(controller.signal);
        if (controller.signal.aborted) return;
        setJobs(items);
        if (items.some((item) => importJobPresentation(item).active)) delay = 2000;
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法读取导入进度");
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void load(), delay);
    };
    void load();
    return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer); };
  }, [api, refresh]);
  const act = async (operation: (signal?: AbortSignal) => Promise<JobRef>) => {
    if (busy) return;
    const signal = lifetime.current?.signal;
    setBusy(true); setError(undefined);
    try { await operation(signal); if (!signal?.aborted) setRefresh((value) => value + 1); }
    catch (reason) { if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "导入操作失败"); }
    finally { if (!signal?.aborted) setBusy(false); }
  };
  return <Surface title="Codex 导入进度">
    <p>导入更新 Maintenance 保存的来源会话；运行回写状态在下方单独显示。</p>
    <div className="dsm-action-row">
      <label>导入范围 <select value={mode} onChange={(event) => setMode(event.target.value as CodexImportRequest["mode"])}>
        <option value="content">会话内容与元数据</option><option value="titles">仅更新会话标题</option>
      </select></label>
      <Button disabled={busy || instanceIds.length === 0} onClick={() => void act((signal) => api.importCodex({ operationId: crypto.randomUUID(), instanceIds, mode }, signal))}>更新已登记的 Codex 来源</Button>
    </div>
    {instanceIds.length === 0 ? <p>尚无可用的 Codex 来源，登记来源后可以开始导入。</p> : null}
    {error === undefined ? null : <p role="alert">{error}</p>}
    {jobs?.length === 0 ? <EmptyState title="暂无导入任务" description="手动导入和导入脚本提交的任务会显示在这里。" /> : jobs?.map((item) => {
      const state = importJobPresentation(item);
      return <article key={item.job.id}>
        <p><Badge tone={item.job.status === "completed" ? "success" : item.job.status === "failed" ? "warning" : "neutral"}>{state.label}</Badge> {item.request.kind === "codex-import" && item.request.mode === "titles" ? "标题更新" : "内容导入"} · {state.detail}</p>
        {state.active ? <Button disabled={busy} onClick={() => void act((signal) => api.cancelCodexImport(item.job.id, signal))}>取消</Button>
          : item.job.status === "failed" ? <Button disabled={busy} onClick={() => void act((signal) => api.resumeCodexImport(item.job.id, signal))}>重试</Button> : null}
        <small> 更新于 <time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString()}</time></small>
      </article>;
    })}
  </Surface>;
}
