// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { VolatilePendingIntentStore, WorkspaceJoinQueue, type WorkspaceJoinIntent } from "../src/client/workspace-join.js";
import { WORKSPACE_MENU_LABEL, installWorkspaceJoinEntry } from "../src/client/workspace-menu.js";
import { workspaceIdFromEvent } from "../src/client/workspace-menu-dom.js";

afterEach(() => { document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const workspaces: Record<string, { name: string; path: string }> = {
  "workspace-a": { name: "工作区 A", path: "D:\\合成\\工作区A" },
};

function setup(deliver: (intent: WorkspaceJoinIntent) => Promise<string>) {
  const feedback: string[] = [];
  const store = new VolatilePendingIntentStore();
  const queue = new WorkspaceJoinQueue({ store, deliver });
  const dispose = installWorkspaceJoinEntry({ queue, instanceId: "i-one", profileId: "web",
    describeWorkspace: id => workspaces[id], onFeedback: message => feedback.push(message) });
  return { feedback, queue, store, dispose };
}

/** The host's workspace menu, as the installed menu plugin renders it. */
async function openWorkspaceMenu(workspaceId: string) {
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.setAttribute("data-dsh-workspace-id", workspaceId);
  const hostItem = document.createElement("button");
  hostItem.setAttribute("role", "menuitem");
  hostItem.textContent = "打开工作区";
  menu.append(hostItem);
  document.body.append(menu);
  // The entry is added by the watcher, so wait for it rather than assuming the tick.
  await vi.waitFor(() => { expect(menu.querySelector("[data-dsh-maintenance-workspace-join]")).not.toBeNull(); });
  return menu;
}

it("adds one workspace-level item to the host's workspace menu", async () => {
  const s = setup(async () => "已加入");
  try {
    const menu = await openWorkspaceMenu("workspace-a");
    const items = menu.querySelectorAll("[data-dsh-maintenance-workspace-join]");
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toBe(WORKSPACE_MENU_LABEL);
    expect(items[0]!.getAttribute("role")).toBe("menuitem");
    // Adding again for the same open menu does not duplicate the entry.
    await openWorkspaceMenu("workspace-a");
    expect(document.querySelectorAll("[data-dsh-maintenance-workspace-join]")).toHaveLength(2);
  } finally { s.dispose(); }
});

it("delivers the join intent for the workspace the item belongs to", async () => {
  const delivered: WorkspaceJoinIntent[] = [];
  const s = setup(async intent => { delivered.push(intent); return "已加入"; });
  try {
    const menu = await openWorkspaceMenu("workspace-a");
    const item = menu.querySelector<HTMLElement>("[data-dsh-maintenance-workspace-join]")!;
    item.click();
    await vi.waitFor(() => { expect(delivered).toHaveLength(1); });
    expect(delivered[0]).toMatchObject({ instanceId: "i-one", profileId: "web", workspaceId: "workspace-a",
      workspaceName: "工作区 A", workspacePath: "D:\\合成\\工作区A" });
    await vi.waitFor(() => { expect(s.feedback.join(" ")).toContain("交给维护引擎"); });
  } finally { s.dispose(); }
});

it("reports a deferred join instead of failing the menu when the Engine is absent", async () => {
  const s = setup(async () => { throw new Error("维护引擎连接描述符不可用"); });
  try {
    const menu = await openWorkspaceMenu("workspace-a");
    menu.querySelector<HTMLElement>("[data-dsh-maintenance-workspace-join]")!.click();
    await vi.waitFor(() => { expect(s.feedback.join(" ")).toContain("待办"); });
    // The intent is kept for the Engine's return, and no error reached the caller.
    expect((await s.store.list()).map(item => item.workspaceId)).toEqual(["workspace-a"]);
  } finally { s.dispose(); }
});

it("reports an unresolvable workspace rather than joining the wrong one", async () => {
  const delivered: unknown[] = [];
  const s = setup(async intent => { delivered.push(intent); return "已加入"; });
  try {
    // The host named a workspace this instance cannot describe.
    const menu = await openWorkspaceMenu("workspace-unknown");
    menu.querySelector<HTMLElement>("[data-dsh-maintenance-workspace-join]")!.click();
    await vi.waitFor(() => { expect(s.feedback.join(" ")).toContain("未加入"); });
    expect(delivered).toEqual([]);
    // A menu item with no workspace identity at all is refused the same way.
    const anonymous = new DOMParser().parseFromString("<button data-dsh-maintenance-workspace-join=workspace-join></button>", "text/html")
      .querySelector<HTMLElement>("button")!;
    document.body.append(anonymous);
    anonymous.click();
    await vi.waitFor(() => { expect(s.feedback.join(" ")).toContain("无法确定"); });
  } finally { s.dispose(); }
});

it("removes its item and stops listening when uninstalled", async () => {
  const s = setup(async () => "已加入");
  await openWorkspaceMenu("workspace-a");
  expect(document.querySelectorAll("[data-dsh-maintenance-workspace-join]")).toHaveLength(1);
  s.dispose();
  expect(document.querySelectorAll("[data-dsh-maintenance-workspace-join]")).toHaveLength(0);
  // The identity reader only reports a workspace the host actually named.
  const named = document.createElement("div");
  named.setAttribute("data-dsh-workspace-id", "workspace-a");
  expect(workspaceIdFromEvent(named)).toBe("workspace-a");
  expect(workspaceIdFromEvent(document.body)).toBeUndefined();
  expect(workspaceIdFromEvent(null)).toBeUndefined();
});
