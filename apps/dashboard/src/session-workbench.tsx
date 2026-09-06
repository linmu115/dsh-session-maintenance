import { useEffect, useState } from "react";

import type { CanonicalDashboardSessionDetail, SyncPlan } from "@linmu/dsh-session-contracts";
import { Badge, Button, EmptyState, LoadingState, Surface } from "@linmu/dsh-session-ui";

import { canonicalOriginLabel } from "./canonical-labels.js";
import { CanonicalEventView } from "./canonical-event-view.js";
import { LineageView } from "./lineage-view.js";
import type { OperationsApi } from "./operations-pages.js";

import { versionMetadataLabel } from "./maintenance-status.js";

export interface WorkbenchApi extends Pick<OperationsApi, "listCanonicalWorkspaces"> {
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
  readonly refreshKey?: number;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    void loadWorkbenchInitial(props.api, props.logicalSessionId, controller.signal).then(
      ({ canonical }) => { if (!controller.signal.aborted) setState({ kind: "ready", value: canonical }); },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ kind: "error", message: error instanceof Error ? error.message : "会话暂时不可用" });
      },
    );
    return () => controller.abort();
  }, [props.api, props.logicalSessionId, props.refreshKey, retry]);

  if (state.kind === "loading") return <Surface><LoadingState label="正在读取已保存的会话…" /></Surface>;
  if (state.kind === "error") return <Surface><EmptyState kind="warning" title="会话暂时不可用" description={state.message} action={<Button onClick={() => setRetry((value) => value + 1)}>重新加载会话</Button>} /></Surface>;
  const detail = state.value;
  const metadataState = versionMetadataLabel(detail.headMetadata);
  return <div className="canonical-workbench" data-testid="canonical-session-workbench">
    <Surface>
      <header className="canonical-session-heading">
        <div><h2>{detail.session.title || "未命名会话"}</h2><p className="muted">已保存的会话 · {new Date(detail.session.updatedAt).toLocaleString()}</p></div>
        <div><Badge>{canonicalOriginLabel(detail.session.originKind)}</Badge><Badge>项目：{detail.project?.name ?? "待指定"}</Badge><Badge>工作区：{detail.workspace?.name ?? "未归类"}</Badge></div>
      </header>
      {metadataState.warning ? <p role="status"><Badge tone="warning">{metadataState.label}</Badge> {metadataState.detail}</p> : null}
      <section className="canonical-transcript" aria-label="静态会话内容">
        {detail.events.length === 0 ? <EmptyState title="还没有会话内容" description="该会话尚未保存可阅读的消息。" /> : detail.events.map((event) => <CanonicalEventView key={event.id} event={event} />)}
      </section>
      <details className="reader-details"><summary>来源与派生会话</summary><LineageView parent={detail.parent} children={detail.children} onOpenSession={props.onOpenSession} /></details>
      <details className="reader-details"><summary>版本、来源与标识</summary><dl className="canonical-metadata">
        <div><dt>会话标识</dt><dd><code>{detail.session.id}</code></dd></div><div><dt>版本元数据</dt><dd><Badge tone={metadataState.warning ? "warning" : "neutral"}>{metadataState.label}</Badge> {metadataState.detail}</dd></div>
        <div><dt>来源类型</dt><dd>{canonicalOriginLabel(detail.session.originKind)}</dd></div>
        <div><dt>权威范围</dt><dd>{detail.session.authorityScope}</dd></div>
        <div><dt>Head 版本</dt><dd><code>{detail.session.headVersionId ?? "尚无"}</code></dd></div>
        <div><dt>工作区</dt><dd>{detail.workspace?.name ?? "未归类"}</dd></div>
        <div><dt>项目</dt><dd>{detail.project?.name ?? "待指定项目"}</dd></div>
        <div><dt>项目根</dt><dd>{detail.projectRoots.length === 0 ? "无" : detail.projectRoots.map((root) => root.path).join("、")}</dd></div>
        <div><dt>原生会话引用</dt><dd>{detail.nativeReferences.references.length === 0 ? "无" : <ul className="native-session-references">{detail.nativeReferences.references.map((reference) => <li key={`${reference.referenceUse}:${reference.platform}:${reference.instanceId}:${reference.nativeSessionId}:${reference.runId ?? ""}`}>
          <Badge>{reference.referenceUse === "source" ? "来源" : reference.referenceUse === "active-projection" ? "当前实例" : "历史链接"}</Badge>{" "}
          {reference.platform} / {reference.instanceId} / <code>{reference.nativeSessionId}</code>
          {reference.adapterId === null ? null : <> / <code>{reference.adapterId}</code></>}
        </li>)}</ul>}</dd></div>
        <div><dt>标签</dt><dd>{detail.session.tags.length === 0 ? "无" : detail.session.tags.join("、")}</dd></div>
        <div><dt>更新时间</dt><dd><time dateTime={detail.session.updatedAt}>{new Date(detail.session.updatedAt).toLocaleString()}</time></dd></div>
      </dl></details>
    </Surface>
  </div>;
}
