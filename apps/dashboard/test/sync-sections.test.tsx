// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CodexProjectMappingConfiguration, InstanceWorkspaceConfiguration } from "@linmu/dsh-session-contracts";
import { SyncSettingsPage } from "../src/sync-page.js";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
function apiFixture() {
  const maintenance: InstanceWorkspaceConfiguration = {
    policy: { schemaVersion: 1, instanceId: "fixture", revision: 0, selection: { kind: "all" }, updatedAt: null },
    activeScopes: [], workspaces: [], pendingActivation: false,
  };
  const codex: CodexProjectMappingConfiguration = {
    policy: { revision: 0, activeRevision: 0, configured: true, activeConfigured: true, projectKeys: [], activeProjectKeys: [], includeFutureSessions: true },
    projects: [{ key: "fixture/project", instanceId: "fixture", projectId: "project", name: "合成项目", roots: [], sessionCount: 1, kind: "local", eligible: true, issues: [] }],
    issues: [], pendingActivation: false, observer: { state: "idle", lastSyncAt: null, lastError: null },
  };
  return {
    listInstanceWorkspaceInstances: vi.fn(async () => ({ instances: [{ instanceId: "fixture", name: "合成实例" }] })),
    getInstanceWorkspaceSync: vi.fn(async () => maintenance), saveInstanceWorkspaceSync: vi.fn(),
    getCodexProjectMapping: vi.fn(async () => codex), saveCodexProjectMapping: vi.fn(),
  };
}
const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const panel = (index: number) => container.querySelectorAll<HTMLDivElement>('[role="tabpanel"]')[index]!;
async function click(element: HTMLElement) { await act(async () => element.click()); }

it("shows peer tabs, reads each section on first visit, and retains both drafts without saving", async () => {
  const api = apiFixture();
  await act(async () => root.render(<SyncSettingsPage api={api} />));
  expect(container.querySelector(".sync-settings")!.firstElementChild?.tagName).toBe("NAV");
  expect(panel(0).parentElement).toBe(container.querySelector(".sync-settings"));
  expect(tabs().map(tab => tab.textContent)).toEqual(["Maintenance 工作区同步", "Codex 项目同步"]);
  expect(panel(0).hidden).toBe(false); expect(panel(1).hidden).toBe(true);
  expect(api.getCodexProjectMapping).not.toHaveBeenCalled();
  const selectedOnly = panel(0).querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!;
  await click([...panel(0).querySelectorAll("button")].find(button => button.textContent === "编辑")!);
  await click(selectedOnly);
  expect(panel(0).textContent).toContain("编辑同步范围");
  await click(tabs()[1]!);
  expect(panel(0).hidden).toBe(true); expect(panel(1).hidden).toBe(false);
  const project = panel(1).querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await click([...panel(1).querySelectorAll("button")].find(button => button.textContent === "编辑")!);
  await click(project);
  await click(tabs()[0]!);
  expect(selectedOnly.checked).toBe(true);
  await click(tabs()[1]!);
  expect(project.checked).toBe(true);
  expect(api.getInstanceWorkspaceSync).toHaveBeenCalledTimes(1);
  expect(api.getCodexProjectMapping).toHaveBeenCalledTimes(1);
  expect(api.saveInstanceWorkspaceSync).not.toHaveBeenCalled();
  expect(api.saveCodexProjectMapping).not.toHaveBeenCalled();
});

it("supports keyboard tab navigation with matching panel relationships", async () => {
  await act(async () => root.render(<SyncSettingsPage api={apiFixture()} />));
  for (const [from, key, to] of [[0, "ArrowRight", 1], [1, "Home", 0], [0, "End", 1], [1, "ArrowLeft", 0]] as const) {
    await act(async () => tabs()[from]!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    expect(document.activeElement).toBe(tabs()[to]);
    expect(tabs()[to]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs()[to]!.tabIndex).toBe(0);
    expect(panel(to).hidden).toBe(false);
    expect(tabs()[to]!.getAttribute("aria-controls")).toBe(panel(to).id);
    expect(panel(to).getAttribute("aria-labelledby")).toBe(tabs()[to]!.id);
  }
});
