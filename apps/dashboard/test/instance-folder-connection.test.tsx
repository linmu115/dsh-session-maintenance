// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { IntegrationDirectory } from "@linmu/dsh-session-contracts";
import { IntegrationPage } from "../src/integration-page.js";

const directory = { targets: [], launcherDetected: false, nativeSyncSupported: false as const, nativeSyncReason: "合成目录" };

/** The hint is required next to the selection bar, before anything is chosen. */
it("states which folder level to choose before any selection is made", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const api = { listIntegrations: vi.fn(async () => directory), integrationAction: vi.fn(), selectInstanceFolder: vi.fn() };
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  try {
    await act(async () => root.render(<IntegrationPage api={api} />));
    expect(node.textContent).toContain("选择 DSH Home 根目录，其中包含 profiles/ 与 sessions/；同一 Home 下的多个 profile 会被分别识别");
    expect(node.textContent).toContain("选择实例文件夹…");
    expect(api.selectInstanceFolder).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); node.remove(); }
});

it("describes the selected Home and its profiles without claiming anything was connected", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const api = {
    listIntegrations: vi.fn(async () => directory), integrationAction: vi.fn(),
    selectInstanceFolder: vi.fn(async () => ({ hint: "选择 DSH Home 根目录，其中包含 profiles/ 与 sessions/；同一 Home 下的多个 profile 会被分别识别",
      cancelled: false as const, pendingId: "select-fixture",
      inspection: { homeRoot: "C:\\合成\\my-dsh-home", suggestedInstanceId: "my-dsh-home",
        profiles: [{ profileId: "web", root: "C:\\合成\\my-dsh-home\\profiles\\web", web: true },
          { profileId: "web-desktop", root: "C:\\合成\\my-dsh-home\\profiles\\web-desktop", web: false }],
        runtimeVersion: "0.1.5-rc.2", versionRoot: "C:\\合成\\runtime", cliPath: "C:\\合成\\runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js", declaredRuntimeVersion: null } })),
  };
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  const click = async (text: string) => { await act(async () => { [...node.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!.click(); }); };
  try {
    await act(async () => root.render(<IntegrationPage api={api} />));
    await click("选择实例文件夹…");
    expect(node.textContent).toContain("my-dsh-home · DSH 0.1.5-rc.2");
    // Each profile inside the Home is reported separately, and the Web one is marked.
    expect(node.textContent).toContain("识别到 2 个配置：web（Web）、web-desktop");
    expect(node.textContent).toContain("还没有登记任何接入");
    // Choosing is not connecting: the disconnect/connect actions stay untouched.
    expect(api.integrationAction).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); node.remove(); }
});

it("registers the chosen profile only when the operator confirms, and says which state it is in", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const connected: IntegrationDirectory = { targets: [{ id: "dsh-1", kind: "dsh", name: "my-dsh-home", version: "0.1.5-rc.2",
    profile: "web-i27c4", connectionKind: "directory", status: "connected", adapterId: "dsh-0.1.5",
    capabilities: [], issues: [] }], launcherDetected: false, nativeSyncSupported: false, nativeSyncReason: "合成目录" };
  const api = {
    listIntegrations: vi.fn(async () => directory), integrationAction: vi.fn(),
    confirmInstanceFolder: vi.fn(async () => connected),
    selectInstanceFolder: vi.fn(async () => ({ hint: "提示", cancelled: false as const, pendingId: "select-fixture",
      inspection: { homeRoot: "C:\\合成\\my-dsh-home", suggestedInstanceId: "my-dsh-home",
        profiles: [{ profileId: "web", root: "C:\\合成\\my-dsh-home\\profiles\\web", web: true }],
        runtimeVersion: "0.1.5-rc.2", versionRoot: "C:\\合成\\runtime", cliPath: "C:\\合成\\runtime\\bin.js", declaredRuntimeVersion: null } })),
  };
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  const click = async (text: string) => { await act(async () => { [...node.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!.click(); }); };
  try {
    await act(async () => root.render(<IntegrationPage api={api} />));
    await click("选择实例文件夹…");
    // Checking alone must never register anything.
    expect(api.confirmInstanceFolder).not.toHaveBeenCalled();
    await click("接入此实例（web）");
    // Confirmation names the pending check and the profile, never a path.
    expect(api.confirmInstanceFolder).toHaveBeenCalledWith({ pendingId: "select-fixture", profileId: "web" }, expect.anything());
    expect(node.textContent).toContain("已登记配置");
    // The refreshed list replaces the "nothing registered yet" wording, and the source is shown.
    expect(node.textContent).toContain("web-i27c4");
    expect(node.textContent).toContain("来源：实例文件夹");
  } finally { await act(async () => root.unmount()); node.remove(); }
});

it("stays out of the way when the engine cannot offer the folder entry", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const api = { listIntegrations: vi.fn(async () => directory) };
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  try {
    await act(async () => root.render(<IntegrationPage api={api} />));
    // An older Engine has no folder entry; the page's own capability message is the only report.
    expect(node.querySelector(".instance-folder-selection")).toBeNull();
    expect(node.textContent).toContain("当前维护引擎未提供接入操作");
  } finally { await act(async () => root.unmount()); node.remove(); }
});

it("treats a cancelled choice as a normal outcome and surfaces a refusal as an error", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const api = {
    listIntegrations: vi.fn(async () => directory), integrationAction: vi.fn(),
    selectInstanceFolder: vi.fn().mockResolvedValueOnce({ hint: "提示", cancelled: true })
      .mockRejectedValueOnce(new Error("所选文件夹不是 DSH Home：缺少 profiles 文件夹")),
  };
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  const click = async (text: string) => { await act(async () => { [...node.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!.click(); }); };
  try {
    await act(async () => root.render(<IntegrationPage api={api} />));
    await click("选择实例文件夹…");
    expect(node.textContent).toContain("已取消选择，未接入任何实例");
    await click("选择实例文件夹…");
    expect(node.textContent).toContain("所选文件夹不是 DSH Home");
  } finally { await act(async () => root.unmount()); node.remove(); }
});
