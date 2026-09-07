import { lazy, Suspense, useEffect, useId, useState } from "react";
import { ChevronDown, FolderOpen } from "lucide-react";
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
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const directoryId = useId();
  const openSession = (id: string) => { setDirectoryOpen(false); onOpenSession(id); };
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
  const selectedWorkspace = directory?.workspaces.find((entry) => entry.sessions.some(({ session }) => session.id === selectedSessionId))?.workspace.name;
  return <div className="session-reading-layout">
      <aside className="session-directory-pane" aria-label="工作区与会话" data-open={directoryOpen}>
        <button className="workspace-panel-toggle" type="button" aria-expanded={directoryOpen} aria-controls={directoryId} onClick={() => setDirectoryOpen((value) => !value)}>
          <span className="workspace-toggle-label"><FolderOpen size={16} aria-hidden="true" />工作区与会话</span>
          {selectedWorkspace === undefined ? null : <span className="workspace-toggle-current">{selectedWorkspace}</span>}
          <ChevronDown size={15} aria-hidden="true" />
        </button>
        <div className="session-directory-content" id={directoryId}>
        <Surface title="工作区">
          {loading ? <LoadingState label="正在读取工作区…" /> : null}
          {error === undefined ? null : <EmptyState kind="warning" title="工作区暂时不可用" description={error} action={<Button onClick={() => setRetry((value) => value + 1)}>重新加载工作区</Button>} />}
          {directory === undefined ? null : <WorkspaceDirectory directory={directory} selectedSessionId={selectedSessionId} onOpenSession={openSession} />}
        </Surface>
        </div>
      </aside>
      <section className="session-reading-pane" aria-label="会话阅读">
        {selectedSessionId === undefined ? <Surface><EmptyState title="选择一个会话，开始阅读" description="左侧按工作区收纳会话，也可以搜索标题。这里只展示已保存的内容。" /></Surface> : <Suspense fallback={<Surface><LoadingState label="正在打开会话…" /></Surface>}><SessionWorkbench api={api} logicalSessionId={selectedSessionId} refreshKey={refreshKey} onOpenSession={onOpenSession} /></Suspense>}
      </section>
    </div>;
}
