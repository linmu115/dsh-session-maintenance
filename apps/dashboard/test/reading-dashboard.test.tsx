// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalDashboardSessionDetail, CanonicalWorkspaceDirectory, CheckpointRestoreCapability, IntegrationDirectory, WorkspaceSyncConfiguration } from "@linmu/dsh-session-contracts";
import { DashboardApp, type DashboardApi } from "../src/app.js";
import { SessionWorkbench } from "../src/session-workbench.js";
import { IntegrationPage } from "../src/integration-page.js";
import { SyncPage } from "../src/sync-page.js";
import { SettingsPage, type OperationsApi } from "../src/operations-pages.js";
import { RecentlyDeletedPage } from "../src/recently-deleted.js";
import { CheckpointsPage, type CatalogApi } from "../src/catalog-pages.js";
import { StorageGovernancePage, type StorageGovernanceApi } from "../src/storage-governance.js";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
async function render(node: ReactNode) { await act(async () => { root.render(node); }); }
function button(label: string) {
  const result = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function input(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const at = "2026-09-06T00:00:00.000Z";
function detail(id: string, title = id): CanonicalDashboardSessionDetail {
  return {
    schemaVersion: 1, session: { schemaVersion: 1, id, authorityScope: "maintenance", originKind: "maintenance-native", headVersionId: null, title, tags: [], archivedAt: null, tombstonedAt: null, createdAt: at, updatedAt: at },
    membership: null, workspace: null, projectMembership: null, project: { name: "独立项目" }, projectRoots: [], headMetadata: null,
    nativeReferences: { schemaVersion: 1, logicalSessionId: id, references: [] }, parent: null, children: [],
    events: [{ schemaVersion: 1, id: `event-${id}`, logicalSessionId: id, sequence: 0, kind: "assistant-message", role: "assistant", readableText: `## ${title} 的正文\n\n**已保存**`, content: { content: [{ type: "text", text: `## ${title} 的正文\n\n**已保存**` }] }, source: { platform: "dsh", instanceId: "synthetic", sessionId: id, eventId: null, cursor: null }, contentDigest: "synthetic", rawPayload: null, extensions: {} }],
  } as unknown as CanonicalDashboardSessionDetail;
}
const directory = {
  schemaVersion: 1, workspaces: [{ workspace: { schemaVersion: 1, id: "workspace-1", parentId: null, name: "研究工作区", sortKey: "a", deletedAt: null, createdAt: at, updatedAt: at }, sessions: [{ session: detail("one", "第一条").session, membership: null }, { session: detail("two", "第二条").session, membership: null }] }], unclassified: [],
} as unknown as CanonicalWorkspaceDirectory;
const integration: IntegrationDirectory = {
  targets: [{ id: "dsh-fixture", kind: "dsh", name: "测试 DSH", version: "1.0", profile: "synthetic", status: "available", adapterId: null, capabilities: [{ id: "read", label: "读取会话", status: "supported", detail: "已验证" }], issues: [] }],
  launcherDetected: true, nativeSyncSupported: false, nativeSyncReason: "Codex 原生回写尚未通过能力检查。",
};
const sync: WorkspaceSyncConfiguration = {
  policy: { revision: 3, workspaceIds: [], includeFutureSessions: true, nativeWriteEnabled: false },
  workspaces: [{ id: "workspace-1", name: "研究工作区", roots: ["synthetic/workspace"], sessionCount: 2, eligible: true, reason: "可保存范围" }], nativeSyncSupported: false, nativeSyncReason: "Codex 原生回写尚未通过能力检查。",
};

describe("reading-first dashboard behavior", () => {
  it("defaults to workspaces, preserves selection and search, and never requests overview for reading", async () => {
    const listCanonicalWorkspaces = vi.fn(async () => directory);
    const getCanonicalSession = vi.fn(async (id: string) => detail(id, id === "one" ? "第一条" : "第二条"));
    const overview = vi.fn(() => Promise.reject(new Error("Harness offline")));
    const api = { listCanonicalWorkspaces, getCanonicalSession, overview, getWorkspaceSync: async () => sync } as unknown as DashboardApi;
    await render(<DashboardApp api={api} />);
    expect([...container.querySelectorAll("nav button")].map((item) => item.textContent)).toEqual(["会话", "同步", "恢复点", "存储空间", "设置"]);
    expect(container.querySelector('nav button[data-active="true"]')?.textContent).toBe("会话");
    await click(container.querySelector('[data-testid="canonical-session-one"]')!);
    expect(container.querySelector('[aria-label="会话阅读"] h2')?.textContent).toBe("第一条");
    expect(container.querySelector(".safe-markdown h2")?.textContent).toBe("第一条 的正文");
    expect(container.querySelector('[aria-label="会话阅读"] input, [aria-label="会话阅读"] textarea, [contenteditable="true"]')).toBeNull();
    expect(container.querySelector('[data-testid="canonical-session-one"]')?.getAttribute("aria-current")).toBe("true");
    expect(container.textContent).not.toContain("管理");
    const search = container.querySelector('.workspace-search input') as HTMLInputElement;
    await input(search, "第一条");
    expect(container.querySelector('[data-testid="canonical-session-two"]')).toBeNull();
    await click(button("同步"));
    await click(button("会话"));
    expect(search.value).toBe("第一条");
    expect(container.querySelector('[aria-label="会话阅读"] h2')?.textContent).toBe("第一条");
    expect(overview).not.toHaveBeenCalled();
    expect(getCanonicalSession).toHaveBeenCalledTimes(1);
  });

  it("keeps the directory available when reading fails and retries the selected session", async () => {
    const getCanonicalSession = vi.fn().mockRejectedValueOnce(new Error("读取失败")).mockResolvedValue(detail("one"));
    await render(<DashboardApp api={{ listCanonicalWorkspaces: async () => directory, getCanonicalSession } as unknown as DashboardApi} />);
    await click(container.querySelector('[data-testid="canonical-session-one"]')!);
    expect(container.textContent).toContain("读取失败");
    expect(container.querySelector('[aria-label="工作区与会话"]')).not.toBeNull();
    await click(button("重新加载会话"));
    expect(container.querySelector(".safe-markdown")).not.toBeNull();
  });

  it("ignores cancelled session responses even when the transport resolves after switching", async () => {
    const old = deferred<CanonicalDashboardSessionDetail>();
    let oldSignal: AbortSignal | undefined;
    const api = { listCanonicalWorkspaces: async () => directory, getCanonicalSession: vi.fn((id: string, signal?: AbortSignal) => { if (id === "old") { oldSignal = signal; return old.promise; } return Promise.resolve(detail(id)); }) };
    await render(<SessionWorkbench api={api} logicalSessionId="old" onOpenSession={() => undefined} />);
    await render(<SessionWorkbench api={api} logicalSessionId="new" onOpenSession={() => undefined} />);
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => old.resolve(detail("old")));
    expect(container.querySelector("h2")?.textContent).toBe("new");
  });

  it("retries directory failures and aborts outstanding directory loads on unmount", async () => {
    let signal: AbortSignal | undefined;
    const pending = deferred<CanonicalWorkspaceDirectory>();
    const listCanonicalWorkspaces = vi.fn().mockRejectedValueOnce(new Error("目录暂时离线")).mockImplementationOnce((value: AbortSignal) => { signal = value; return pending.promise; });
    await render(<DashboardApp api={{ listCanonicalWorkspaces } as unknown as DashboardApi} />);
    expect(container.textContent).toContain("目录暂时离线");
    await click(button("重新加载工作区"));
    await render(null);
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(directory));
    expect(container.textContent).toBe("");
  });
});

describe("integration and sync controls", () => {
  it("calls connect, check, repair and disconnect and uses returned status", async () => {
    const integrationAction = vi.fn(async (_id: string, action: string) => ({ ...integration, targets: integration.targets.map((target) => ({ ...target, status: action === "check" ? "needs-attention" as const : action === "disconnect" ? "available" as const : "connected" as const })) }));
    await render(<IntegrationPage api={{ listIntegrations: async () => integration, integrationAction }} />);
    await click(button("接入并检查"));
    expect(container.textContent).toContain("已接入");
    await click(button("重新检查")); await click(button("修复")); await click(button("断开"));
    expect(integrationAction.mock.calls.map((call) => call.slice(0, 2))).toEqual([["dsh-fixture", "connect"], ["dsh-fixture", "check"], ["dsh-fixture", "repair"], ["dsh-fixture", "disconnect"]]);
    expect(container.textContent).toContain("可接入");
  });

  it("shows action errors and missing APIs without pretending success", async () => {
    await render(<IntegrationPage api={{ listIntegrations: async () => integration, integrationAction: async () => { throw new Error("接入检查失败"); } }} />);
    await click(button("接入并检查"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("接入检查失败");
    expect(container.querySelector('[role="status"]')).toBeNull();
    await render(<IntegrationPage api={{}} />);
    expect(container.textContent).toContain("未提供接入管理");
  });

  it("saves a revisioned whitelist including future sessions without claiming native sync", async () => {
    const saveWorkspaceSync = vi.fn(async (value) => ({ ...sync, policy: { ...sync.policy, revision: 4, workspaceIds: value.workspaceIds } }));
    await render(<SyncPage api={{ getWorkspaceSync: async () => sync, saveWorkspaceSync }} />);
    expect(button("保存同步范围").disabled).toBe(true);
    await click(container.querySelector('input[type="checkbox"]')!);
    await click(button("保存同步范围"));
    expect(saveWorkspaceSync).toHaveBeenCalledWith({ revision: 3, workspaceIds: ["workspace-1"] }, expect.any(AbortSignal));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("配置已保存");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("原生回写尚未生效");
    expect(container.textContent).toContain("未来新增");
    expect(button("保存同步范围").disabled).toBe(true);
  });

  it("keeps inactive native-sync switches out of maintenance preferences", async () => {
    await render(<SettingsPage api={{ getSettings: async () => ({ codexInstanceId: "legacy", dshInstanceId: null, workspaceMappingId: null, scanScope: "current", backupRetention: 3, syncSingleSidedTitle: true, syncArchive: true, allowBatchSafeApply: false }) } as unknown as OperationsApi} />);
    expect(container.textContent).not.toContain("双向同步归档状态");
    expect(container.textContent).not.toContain("同步单边标题变化");
    expect(container.querySelector('input:not([type="number"]):not([type="checkbox"])')).toBeNull();
    expect(container.textContent).toContain("历史同步开关不代表原生回写已启用");
  });

  it("keeps edits after save failure and does not allow missing save capability", async () => {
    await render(<SyncPage api={{ getWorkspaceSync: async () => sync, saveWorkspaceSync: async () => { throw new Error("版本冲突，请重新读取"); } }} />);
    await click(container.querySelector('input[type="checkbox"]')!); await click(button("保存同步范围"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("版本冲突");
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
    expect(container.querySelector('[role="status"]')).toBeNull();
    await render(<SyncPage api={{ getWorkspaceSync: async () => sync }} />);
    expect(container.textContent).toContain("未提供保存同步配置");
    expect(button("保存同步范围").disabled).toBe(true);
  });
});

describe("recovery and storage explanations", () => {
  it("explains saved references and restoration impact before requesting a preview", async () => {
    const createCheckpointRestorePlan = vi.fn(async () => ({ id: "plan", risk: "safe", operations: [], confirmations: [] }));
    await render(<CheckpointsPage api={{ listCheckpoints: async () => [{ id: "checkpoint", name: "测试恢复点", description: "保存说明", createdAt: at, refs: { head: "version" } }], overview: async () => ({ instances: [{ id: "dsh", platform: "dsh", displayName: "本地 DSH" }] }), getCheckpointRestoreCapability: async (checkpointId: string) => ({ checkpointId, supported: true, reason: "旧版来源可用于预览" }), createCheckpointRestorePlan } as unknown as CatalogApi} />);
    expect(container.textContent).toContain("保存选定会话版本的引用与说明");
    expect(container.textContent).toContain("当前 DSH 分支和之后的版本都保留");
    expect(container.querySelector("time")?.dateTime).toBe(at);
    expect(createCheckpointRestorePlan).not.toHaveBeenCalled();
    await click(button("生成恢复计划预览"));
    expect(createCheckpointRestorePlan).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("不会自动应用、重置或删除");
  });

  it("makes recently deleted recovery visible and refreshes the workspace directory after restoring", async () => {
    const listCanonicalWorkspaces = vi.fn(async () => directory);
    const listRecentlyDeleted = vi.fn().mockResolvedValueOnce([{ session: detail("deleted", "曾删除的会话").session, tombstone: { checkpointId: "protection" }, pendingOperations: 0 }]).mockResolvedValue([]);
    const restoreCanonicalSession = vi.fn(async () => ({ logicalSessionId: "deleted", state: "restored", workspaceId: null }));
    await render(<DashboardApp api={{ listCanonicalWorkspaces, listRecentlyDeleted, restoreCanonicalSession, listCheckpoints: async () => [], overview: async () => ({ instances: [] }) } as unknown as DashboardApi} />);
    await click(button("恢复点"));
    const restore = button("恢复已删除会话");
    expect(restore.closest("details")).toBeNull();
    expect(container.textContent).toContain("不会将正文回退到某个历史版本");
    await click(restore);
    expect(restoreCanonicalSession).toHaveBeenCalledWith("deleted", expect.any(AbortSignal));
    expect(container.textContent).toContain("会话已恢复");
    expect(container.querySelector('[data-testid="recently-deleted-deleted"]')).toBeNull();
    expect(listCanonicalWorkspaces).toHaveBeenCalledTimes(2);
  });

  it("keeps deleted sessions visible when restore fails and makes the failure explicit", async () => {
    await render(<RecentlyDeletedPage api={{ listRecentlyDeleted: async () => [{ session: detail("deleted").session, tombstone: null, pendingOperations: 0 }] as never, restoreCanonicalSession: async () => { throw new Error("暂时无法撤销删除"); } }} onOpenSession={() => undefined} />);
    await click(button("恢复已删除会话"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("暂时无法撤销删除");
    expect(container.querySelector('[data-testid="recently-deleted-deleted"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("disables legacy preview when source support is unavailable, false, or fails to load", async () => {
    const createCheckpointRestorePlan = vi.fn();
    const base = { listCheckpoints: async () => [{ id: "normal-record", name: "已保存记录", description: "", refs: { head: "version" }, createdAt: at }], overview: async () => ({ instances: [{ id: "dsh", platform: "dsh", displayName: "本地 DSH" }] }), createCheckpointRestorePlan } as unknown as CatalogApi;
    await render(<CheckpointsPage api={base} />);
    expect(button("生成恢复计划预览").disabled).toBe(true);
    expect(container.textContent).toContain("未提供恢复来源核验");
    expect(container.querySelector("input, textarea")).toBeNull();
    await render(<CheckpointsPage api={{ ...base, getCheckpointRestoreCapability: async (checkpointId) => ({ checkpointId, supported: false, reason: "此保护记录仅支持撤销删除" }) }} />);
    expect(button("生成恢复计划预览").disabled).toBe(true);
    expect(container.textContent).toContain("此保护记录仅支持撤销删除");
    await render(<CheckpointsPage api={{ ...base, getCheckpointRestoreCapability: async () => { throw new Error("对象核验失败"); } }} />);
    expect(button("生成恢复计划预览").disabled).toBe(true);
    expect(container.textContent).toContain("无法核验恢复来源：对象核验失败");
    expect(createCheckpointRestorePlan).not.toHaveBeenCalled();
  });

  it("ignores late source capabilities after selecting another checkpoint", async () => {
    const old = deferred<CheckpointRestoreCapability>();
    let oldSignal: AbortSignal | undefined;
    const api = { listCheckpoints: async () => ["first", "second"].map((id) => ({ id, name: id, description: "", refs: { head: id }, createdAt: at })), overview: async () => ({ instances: [{ id: "dsh", platform: "dsh", displayName: "本地 DSH" }] }), getCheckpointRestoreCapability: (id: string, signal?: AbortSignal) => { if (id === "first") { oldSignal = signal; return old.promise; } return Promise.resolve({ checkpointId: id, supported: false, reason: "第二条不支持旧版恢复" }); } } as unknown as CatalogApi;
    await render(<CheckpointsPage api={api} />);
    expect(button("生成恢复计划预览").disabled).toBe(true);
    await click(container.querySelectorAll<HTMLButtonElement>(".checkpoint-picker button")[1]!);
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => old.resolve({ checkpointId: "first", supported: true, reason: "迟到的旧结果" }));
    expect(button("生成恢复计划预览").disabled).toBe(true);
    expect(container.textContent).toContain("第二条不支持旧版恢复");
    expect(container.textContent).not.toContain("迟到的旧结果");
  });
  it("explains protected and reclaimable space and retains preview approval", async () => {
    const executeRetention = vi.fn();
    await render(<StorageGovernancePage api={{ previewRetention: async () => ({ id: "preview", protectedBytes: 20, executableBytes: 10, cacheBytesAboveTarget: 0, items: [], blockers: [], policy: { finishedRunHours: 24, recoveredRunHours: 24, automaticBackupsToKeep: 2, cacheTargetBytes: 100, quarantineHours: 24 } }), listRetentionBatches: async () => [], getRetentionRegistry: async () => ({ roots: [], sources: [], resources: [] }), executeRetention } as unknown as StorageGovernanceApi} />);
    expect(container.textContent).toContain("受保护空间仍被会话、恢复点或未完成操作使用");
    expect(container.textContent).toContain("隔离不等于立即释放磁盘空间");
    expect(button("隔离本次候选副本").disabled).toBe(true);
    expect(executeRetention).not.toHaveBeenCalled();
    await click(container.querySelector('input[type="checkbox"]')!);
    expect(button("隔离本次候选副本").disabled).toBe(false);
  });
});
