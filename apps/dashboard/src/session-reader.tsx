import { lazy, Suspense, useEffect, useState } from "react";
import type { CanonicalWorkspaceDirectory } from "@linmu/dsh-session-contracts";
import { Button, EmptyState, LoadingState, Surface } from "@linmu/dsh-session-ui";
import { WorkspaceDirectory } from "./workspace-directory.js";
import type { WorkbenchApi } from "./session-workbench.js";
const SessionWorkbench = lazy(async () => ({ default: (await import("./session-workbench.js")).SessionWorkbench }));

export function SessionReader({ api, refreshKey, selectedSessionId, onOpenSession }: {
  readonly api: WorkbenchApi;
  readonly refreshKey: number;
  readonly selectedSessionId: string | undefined;
  readonly onOpenSession: (id: string) => void;
}) {
  const [directory, setDirectory] = useState<CanonicalWorkspaceDirectory>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setError(undefined); setLoading(true);
    void api.listCanonicalWorkspaces(controller.signal).then((value) => {
      if (!controller.signal.aborted) { setDirectory(value); setLoading(false); }
    }, (reason: unknown) => {
      if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : "无法读取工作区"); setLoading(false); }
    });
    return () => controller.abort();
  }, [api, refreshKey, retry]);
  return <>
    <div className="dsm-page-heading"><div><h2>会话</h2><p>按工作区找到会话，继续阅读已保存的内容。</p></div><span className="reading-label">只读浏览</span></div>
    <div className="session-reading-layout">
      <aside className="session-directory-pane" aria-label="工作区与会话">
        <Surface title="工作区">
          {loading ? <LoadingState label="正在读取工作区…" /> : null}
          {error === undefined ? null : <EmptyState kind="warning" title="工作区暂时不可用" description={error} action={<Button onClick={() => setRetry((value) => value + 1)}>重新加载工作区</Button>} />}
          {directory === undefined ? null : <WorkspaceDirectory directory={directory} selectedSessionId={selectedSessionId} onOpenSession={onOpenSession} />}
        </Surface>
      </aside>
      <section className="session-reading-pane" aria-label="会话阅读">
        {selectedSessionId === undefined ? <Surface><EmptyState title="选择一个会话，开始阅读" description="左侧按工作区收纳会话，也可以搜索标题。这里只展示已保存的内容。" /></Surface> : <Suspense fallback={<Surface><LoadingState label="正在打开会话…" /></Surface>}><SessionWorkbench api={api} logicalSessionId={selectedSessionId} refreshKey={refreshKey} onOpenSession={onOpenSession} /></Suspense>}
      </section>
    </div>
  </>;
}
