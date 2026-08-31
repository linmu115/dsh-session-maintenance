import { useEffect, useState } from "react";

import type { CanonicalDashboardSessionDetail, SyncPlan } from "@linmu/dsh-session-contracts";
import { Badge, EmptyState, LoadingState, LocalTabs, Surface } from "@linmu/dsh-session-ui";

import { canonicalOriginLabel } from "./canonical-labels.js";
import { CanonicalEventView } from "./canonical-event-view.js";
import { LineageView } from "./lineage-view.js";
import type { DashboardSummaryApi } from "./summary-loader.js";

export interface WorkbenchApi extends DashboardSummaryApi {
  getCanonicalSession(id: string, signal?: AbortSignal): Promise<CanonicalDashboardSessionDetail>;
}

export interface WorkbenchInitial {
  readonly canonical: CanonicalDashboardSessionDetail;
}

export async function loadWorkbenchInitial(api: WorkbenchApi, logicalSessionId: string, signal?: AbortSignal): Promise<WorkbenchInitial> {
  return { canonical: await api.getCanonicalSession(logicalSessionId, signal) };
}

export function planApplyState(plan: SyncPlan | undefined): { readonly allowed: boolean; readonly reason: string } {
  if (plan === undefined) return { allowed: false, reason: "请先生成计划预览" };
  if (plan.risk !== "safe") return { allowed: false, reason: `风险级别为 ${plan.risk}，必须进入人工处理` };
  if (plan.confirmations.length > 0 || plan.operations.some((operation) => operation.type === "require-review")) {
    return { allowed: false, reason: "计划包含人工确认或冲突步骤" };
  }
  return { allowed: true, reason: "该计划通过安全快进门禁" };
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly value: CanonicalDashboardSessionDetail };

export function SessionWorkbench(props: {
  readonly api: WorkbenchApi;
  readonly logicalSessionId: string;
  readonly onOpenSession: (id: string) => void;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [tab, setTab] = useState("content");
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    void loadWorkbenchInitial(props.api, props.logicalSessionId, controller.signal).then(
      ({ canonical }) => setState({ kind: "ready", value: canonical }),
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ kind: "error", message: error instanceof Error ? error.message : "稳定会话不可用" });
      },
    );
    return () => controller.abort();
  }, [props.api, props.logicalSessionId]);

  if (state.kind === "loading") return <Surface><LoadingState label="正在从 Maintenance 稳定存储读取会话…" /></Surface>;
  if (state.kind === "error") return <Surface><EmptyState kind="warning" title="稳定会话不可用" description={state.message} /></Surface>;
  const detail = state.value;
  return <div className="canonical-workbench" data-testid="canonical-session-workbench">
    <Surface>
      <header className="canonical-session-heading">
        <div><h2>{detail.session.title || "未命名会话"}</h2><code>{detail.session.id}</code></div>
        <div><Badge>{canonicalOriginLabel(detail.session.originKind)}</Badge><Badge>{detail.session.authorityScope === "codex" ? "Codex 权威" : "Maintenance 权威"}</Badge>{detail.workspace === null ? <Badge>未归类</Badge> : <Badge>{detail.workspace.name}</Badge>}</div>
      </header>
      <LocalTabs value={tab} onChange={setTab} tabs={[{ id: "content", label: "静态会话" }, { id: "lineage", label: "来源与派生" }, { id: "metadata", label: "元数据" }]} />
      {tab === "content" ? <section className="canonical-transcript" aria-label="Canonical 静态会话内容">
        {detail.events.length === 0 ? <EmptyState title="没有稳定事件" description="该会话尚未导入 CanonicalEventV1。" /> : detail.events.map((event) => <CanonicalEventView key={event.id} event={event} />)}
      </section> : null}
      {tab === "lineage" ? <LineageView parent={detail.parent} children={detail.children} onOpenSession={props.onOpenSession} /> : null}
      {tab === "metadata" ? <dl className="canonical-metadata">
        <div><dt>来源类型</dt><dd>{canonicalOriginLabel(detail.session.originKind)}</dd></div>
        <div><dt>权威范围</dt><dd>{detail.session.authorityScope}</dd></div>
        <div><dt>Head 版本</dt><dd><code>{detail.session.headVersionId ?? "尚无"}</code></dd></div>
        <div><dt>工作区</dt><dd>{detail.workspace?.name ?? "未归类"}</dd></div>
        <div><dt>标签</dt><dd>{detail.session.tags.length === 0 ? "无" : detail.session.tags.join("、")}</dd></div>
        <div><dt>更新时间</dt><dd><time dateTime={detail.session.updatedAt}>{new Date(detail.session.updatedAt).toLocaleString()}</time></dd></div>
      </dl> : null}
    </Surface>
  </div>;
}
