import { lazy, Suspense, useState, type ReactNode } from "react";
import { BookmarkCheck, HardDrive, ListTree, RefreshCw, Settings2 } from "lucide-react";
import { Button, DashboardShell, EmptyState, LoadingState, NavButton, Surface } from "@linmu/dsh-session-ui";
import type { WorkbenchApi } from "./session-workbench.js";
import type { OperationsApi } from "./operations-pages.js";
import type { CatalogApi } from "./catalog-pages.js";
import type { RecentlyDeletedApi } from "./recently-deleted.js";
import type { RunCenterApi } from "./run-center.js";
import type { AdapterPageApi } from "./adapter-page.js";
import type { StorageGovernanceApi } from "./storage-governance.js";
import type { IntegrationApi } from "./integration-page.js";
import type { WorkspaceSyncApi } from "./sync-page.js";
import { SessionReader } from "./session-reader.js";

const PlansPage = lazy(async () => ({ default: (await import("./catalog-pages.js")).PlansPage }));
const CheckpointsPage = lazy(async () => ({ default: (await import("./catalog-pages.js")).CheckpointsPage }));
const TransactionsPage = lazy(async () => ({ default: (await import("./operations-pages.js")).TransactionsPage }));
const DiagnosticsPage = lazy(async () => ({ default: (await import("./operations-pages.js")).DiagnosticsPage }));
const SettingsPage = lazy(async () => ({ default: (await import("./operations-pages.js")).SettingsPage }));
const RecentlyDeletedPage = lazy(async () => ({ default: (await import("./recently-deleted.js")).RecentlyDeletedPage }));
const RunCenterPage = lazy(async () => ({ default: (await import("./run-center.js")).RunCenterPage }));
const AdapterPage = lazy(async () => ({ default: (await import("./adapter-page.js")).AdapterPage }));
const StorageGovernancePage = lazy(async () => ({ default: (await import("./storage-governance.js")).StorageGovernancePage }));
const IntegrationPage = lazy(async () => ({ default: (await import("./integration-page.js")).IntegrationPage }));
const SyncPage = lazy(async () => ({ default: (await import("./sync-page.js")).SyncPage }));

type View = "sessions" | "sync" | "checkpoints" | "storage" | "settings";
export type DashboardApi = WorkbenchApi & OperationsApi & CatalogApi & RecentlyDeletedApi & RunCenterApi & AdapterPageApi & StorageGovernanceApi & IntegrationApi & WorkspaceSyncApi;

/** Advanced tools mount only when opened, so reading never depends on them. */
function Advanced(props: { readonly title: string; readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details className="advanced-section" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{props.title}</summary>{open ? props.children : null}
  </details>;
}

export function DashboardApp(props: { readonly api: DashboardApi; readonly initialLogicalSessionId?: string }) {
  const [view, setView] = useState<View>("sessions");
  const [request, setRequest] = useState(0);
  const [restoredRevision, setRestoredRevision] = useState(0);
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>(props.initialLogicalSessionId);
  const openSession = (id: string) => { setSelectedSessionId(id); setView("sessions"); };
  return <DashboardShell title="会话维护" subtitle="在本地，安心整理与阅读" nav={<>
    <NavButton active={view === "sessions"} icon={ListTree} onClick={() => setView("sessions")}>会话</NavButton>
    <NavButton active={view === "sync"} icon={RefreshCw} onClick={() => setView("sync")}>同步</NavButton>
    <NavButton active={view === "checkpoints"} icon={BookmarkCheck} onClick={() => setView("checkpoints")}>恢复点</NavButton>
    <NavButton active={view === "storage"} icon={HardDrive} onClick={() => setView("storage")}>存储空间</NavButton>
    <NavButton active={view === "settings"} icon={Settings2} onClick={() => setView("settings")}>设置</NavButton>
  </>} actions={<Button onClick={() => setRequest((value) => value + 1)}><RefreshCw size={14} /> 刷新</Button>}>
    <div hidden={view !== "sessions"}>
      <SessionReader api={props.api} refreshKey={request + restoredRevision} selectedSessionId={selectedSessionId} onOpenSession={openSession} />
    </div>
    <Suspense fallback={<Surface><LoadingState label="正在读取…" /></Surface>}>
      {view === "sync" ? <div key={`sync-${request}`} className="page-stack"><SyncPage api={props.api} /><Advanced title="导入与运行进度"><RunCenterPage api={props.api} /></Advanced><Advanced title="高级：历史同步计划"><PlansPage api={props.api} /></Advanced></div> : null}
      {view === "checkpoints" ? <div key={`restore-${request}`} className="page-stack"><div className="dsm-page-heading"><div><h2>恢复点</h2><p>找回最近删除的会话，或查看已有保护记录支持的恢复方式。</p></div></div><RecentlyDeletedPage api={props.api} onOpenSession={openSession} onRestored={() => setRestoredRevision((value) => value + 1)} /><CheckpointsPage api={props.api} /><Advanced title="高级：历史事务与恢复"><TransactionsPage api={props.api} /></Advanced></div> : null}
      {view === "storage" ? <StorageGovernancePage key={request} api={props.api} /> : null}
      {view === "settings" ? <div key={`settings-${request}`} className="page-stack"><div className="dsm-page-heading"><div><h2>设置</h2><p>管理本机接入与维护偏好。</p></div></div><IntegrationPage api={props.api} /><Advanced title="维护偏好"><SettingsPage api={props.api} /></Advanced><Advanced title="高级：诊断"><DiagnosticsPage api={props.api} /></Advanced><Advanced title="高级：适配器详情"><AdapterPage api={props.api} /></Advanced></div> : null}
    </Suspense>
  </DashboardShell>;
}

export function DashboardOffline() {
  return <DashboardShell title="会话维护" subtitle="在本地，安心整理与阅读" nav={null}>
    <Surface><EmptyState kind="offline" title="请重新打开看板" description="本次启动凭据不可用。请从 Maintenance 启动入口重新打开，连接本机保存的会话。" /></Surface>
  </DashboardShell>;
}
