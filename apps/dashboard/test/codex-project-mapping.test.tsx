// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexProjectMappingConfiguration, CodexProjectMappingUpdate } from "@linmu/dsh-session-contracts";
import { SyncPage, type WorkspaceSyncApi } from "../src/sync-page.js";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
async function render(api: WorkspaceSyncApi) { await act(async () => root.render(<SyncPage api={api} />)); }
async function click(element: HTMLElement) { await act(async () => element.click()); }
function button(text: string) {
  const match = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
  if (!match) throw new Error(`Missing button: ${text}`);
  return match;
}
function checkbox(projectId: string) { return container.querySelector(`input[aria-label="映射 同名项目 (fixture / ${projectId})"]`) as HTMLInputElement; }
async function search(value: string) {
  const input = container.querySelector('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function fixture(): CodexProjectMappingConfiguration {
  return {
    policy: { revision: 4, activeRevision: 3, configured: true, activeConfigured: true, projectKeys: ["fixture/b"], activeProjectKeys: ["fixture/a"], includeFutureSessions: true },
    projects: ["a", "b"].map((id) => ({ key: `fixture/${id}`, instanceId: "fixture", projectId: id, name: "同名项目", roots: ["C:/synthetic/shared-root"], sessionCount: 2, kind: id === "b" ? "mixed" : "local", eligible: true, issues: [] })),
    issues: [], pendingActivation: true, observer: { state: "idle", lastSyncAt: null, lastError: null },
  };
}

describe("Codex project mapping", () => {
  it("distinguishes same-name projects, saved and active scopes and saves stable keys", async () => {
    const current = fixture();
    const legacy = vi.fn();
    const save = vi.fn(async (input: CodexProjectMappingUpdate) => ({ ...current, policy: { ...current.policy, revision: 5, projectKeys: input.projectKeys } }));
    await render({ getCodexProjectMapping: async () => current, saveCodexProjectMapping: save, getWorkspaceSync: legacy });
    expect(checkbox("a").checked).toBe(false); expect(checkbox("b").checked).toBe(true);
    expect(container.querySelector('[aria-label="当前活跃名单"]')?.textContent).toContain("fixture / a");
    expect(container.querySelector('[aria-label="最新已保存名单"]')?.textContent).toContain("fixture / b");
    expect(container.textContent).toContain("混合项目 · 仅本地会话");
    expect(container.textContent).toContain("Codex 源会话不会删除");
    expect(container.textContent).toContain("保留恢复点");
    expect(container.textContent).toContain("未来新增本地会话");
    expect(container.querySelector('.mapping-project-detail details')?.textContent).toContain("项目根路径（仅供查看）");
    expect(legacy).not.toHaveBeenCalled();
    await click(checkbox("a")); await click(button("保存为最新映射名单"));
    expect(save).toHaveBeenCalledWith({ revision: 4, projectKeys: ["fixture/b", "fixture/a"] }, expect.any(AbortSignal));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("下次启动 Maintenance");
    expect(container.querySelector('[aria-label="当前活跃名单"]')?.textContent).not.toContain("fixture / b");
    expect(button("保存为最新映射名单").disabled).toBe(true);
  });

  it("keeps selections while searching and cancels drafts or refreshes the complete directory", async () => {
    const current = fixture(); const get = vi.fn(async () => current);
    await render({ getCodexProjectMapping: get, saveCodexProjectMapping: vi.fn() });
    await click(checkbox("a")); await search("fixture/b");
    expect(container.querySelectorAll('.mapping-project')).toHaveLength(1);
    await search(""); expect(checkbox("a").checked).toBe(true);
    await click(button("取消更改")); expect(checkbox("a").checked).toBe(false);
    await click(checkbox("a")); await click(button("刷新目录"));
    expect(get).toHaveBeenCalledTimes(2); expect(checkbox("a").checked).toBe(false);
    expect(container.querySelectorAll('.mapping-project')).toHaveLength(2);
  });

  it("can explicitly save no projects from unconfigured state without treating it as all projects", async () => {
    const current = fixture(); current.policy.configured = false; current.policy.activeConfigured = false;
    current.policy.projectKeys = []; current.policy.activeProjectKeys = []; current.pendingActivation = false;
    const save = vi.fn(async (input: CodexProjectMappingUpdate) => ({ ...current, pendingActivation: true, policy: { ...current.policy, configured: true, revision: 5, projectKeys: input.projectKeys } }));
    await render({ getCodexProjectMapping: async () => current, saveCodexProjectMapping: save });
    expect(container.querySelector('[aria-label="当前活跃名单"]')?.textContent).toContain("未配置");
    expect(checkbox("a").checked).toBe(false); expect(checkbox("b").checked).toBe(false);
    expect(button("保存为最新映射名单").disabled).toBe(false);
    expect(button("取消更改").disabled).toBe(true);
    await click(button("保存为最新映射名单"));
    expect(save).toHaveBeenCalledWith({ revision: 4, projectKeys: [] }, expect.any(AbortSignal));
    expect(container.querySelector('[aria-label="最新已保存名单"]')?.textContent).toContain("不映射任何项目");
    expect(container.querySelector('[aria-label="当前活跃名单"]')?.textContent).toContain("未配置");
  });

  it("keeps drafts on CAS conflict and allows editing during observer errors", async () => {
    const current = fixture(); current.observer = { state: "error", lastSyncAt: null, lastError: "合成导入错误" };
    await render({ getCodexProjectMapping: async () => current, saveCodexProjectMapping: async () => { throw new Error("REVISION_CONFLICT: stale"); } });
    expect(container.textContent).toContain("上次映射更新未完成：合成导入错误");
    await click(checkbox("a")); await click(button("保存为最新映射名单"));
    expect(container.textContent).toContain("请刷新目录，重新核对勾选后再保存");
    expect(checkbox("a").checked).toBe(true);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("explains unavailable APIs and an empty directory", async () => {
    await render({}); expect(container.textContent).toContain("未提供 Codex 项目映射功能");
    await render({ getCodexProjectMapping: async () => { throw new Error("HTTP 404"); } });
    expect(container.textContent).toContain("未提供 Codex 项目映射功能");
    const current = fixture(); current.projects = []; current.policy.projectKeys = []; current.policy.activeProjectKeys = [];
    await render({ getCodexProjectMapping: async () => current });
    expect(container.textContent).toContain("暂未发现 Codex 项目");
    expect(container.textContent).toContain("未提供保存项目映射名单的能力");
    expect(button("保存为最新映射名单").disabled).toBe(true);
    expect(container.querySelector('[aria-label="当前活跃名单"]')?.textContent).toContain("不映射任何项目");
  });

  it("shows ineligible entries and permits removing unavailable saved projects", async () => {
    const current = fixture(); current.projects[0]!.eligible = false; current.projects[0]!.kind = "unknown";
    current.projects[0]!.issues = ["缺少可靠项目归属"];
    current.policy.projectKeys = ["fixture/missing"];
    await render({ getCodexProjectMapping: async () => current, saveCodexProjectMapping: vi.fn() });
    expect(checkbox("a").disabled).toBe(true);
    expect(container.textContent).toContain("缺少可靠项目归属");
    const missing = container.querySelector('.mapping-missing input') as HTMLInputElement;
    expect(missing.checked).toBe(true); await click(missing); expect(missing.checked).toBe(false);
    expect(button("保存为最新映射名单").disabled).toBe(false);
  });

  it("ignores late requests from a replaced API", async () => {
    let resolve!: (value: CodexProjectMappingConfiguration) => void;
    const pending = new Promise<CodexProjectMappingConfiguration>((done) => { resolve = done; });
    const old = vi.fn(async (_signal?: AbortSignal) => pending);
    await render({ getCodexProjectMapping: old });
    const current = fixture(); current.projects = [];
    await render({ getCodexProjectMapping: async () => current });
    expect(old.mock.calls[0]?.[0]?.aborted).toBe(true);
    await act(async () => resolve(fixture()));
    expect(container.textContent).toContain("暂未发现 Codex 项目");
  });
});
