// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ExtensionBusinessPanel, ExtensionDirectoryObject, ExtensionDirectoryQuery, ExtensionDirectoryPage } from "@linmu/dsh-session-contracts";
import { ExtensionPageView, type ExtensionPageApi } from "../src/extension-page.js";

const scope = {instanceId: "copy", profileId: "web", namespace: "annotation-records"};
const member = {scope, label: "引用", writerId: "dsh-annotation-core", pluginVersion: "0.3.12-rc2.10", configured: true, enabled: true, status: "ready" as const, objectCount: 1, conflictCount: 0, bytes: 20, capabilities: {read: true, write: true, delete: true, restore: true, panel: true, context: false as const}};
const panel: ExtensionBusinessPanel = {adapterId: "obsidian-series", label: "Obsidian 系列", scope, instanceLabel: "运行副本", profileLabel: "web", status: "ready", members: [member, {...member, scope: {...scope, namespace: "stickers"}, label: "贴纸"}], objectCount: 2, conflictCount: 0, bytes: 20};
const object: ExtensionDirectoryObject = {type: "object", id: "reference", objectId: "reference", label: "来自 X 的引用", title: "来自 X 的引用", scope, writerId: member.writerId, revision: 3, schemaVersion: 1, deleted: false, updatedAt: "2026-09-15", bytes: 20, conflicts: 0, count: 0, ownerSessionId: "Y", kind: "reference-record", parentObjectId: null, readOnly: true, unavailableReason: null, ownershipReason: null, archived: false, archivedAt: null, missing: false};
const group = (type: "workspace" | "session", id: string, label: string) => ({type, id, label, count: 1, archived: false, archivedAt: null, missing: false});

function fixture() {
  const get = vi.fn().mockResolvedValue({object: {...object, content: {schemaVersion: 1, title: object.title, body: {kind: "reference-record", targetSessionId: "Y", selectedText: "有限选区内容"}, references: [{logicalSessionId: "X"}, {logicalSessionId: "Y"}]}}, summary: "已发送引用", preview: {kind: "rows", rows: [{label: "选区", text: "有限选区内容"}], total: 1}, conflictIds: []});
  const list = vi.fn(async (query: ExtensionDirectoryQuery): Promise<ExtensionDirectoryPage> => ({level: query.level, items: query.level === "workspaces" ? [group("workspace", "work", "研究工作区")] : query.level === "sessions" ? [group("session", "Y", "接收会话 Y")] : [object], nextCursor: null}));
  const api = {listExtensionBusinessPanels: vi.fn().mockResolvedValue([panel, {...panel, adapterId: "thoughtdag", label: "ThoughtDAG", members: []}, {...panel, scope: {instanceId: "main", profileId: "web"}, instanceLabel: "主实例"}]), listExtensionDirectory: list, getExtensionObject: get, writeExtensionObject: vi.fn(), enableExtension: vi.fn()} as unknown as ExtensionPageApi;
  return {api, get, list};
}
async function mount(api: ExtensionPageApi) {
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element); const open = vi.fn();
  await act(async () => root.render(<ExtensionPageView api={api} onOpenSession={open}/>));
  return {element, open, click: async (text: string) => { const button = [...element.querySelectorAll("button")].find(item => item.textContent?.includes(text)); expect(button, text).toBeDefined(); await act(async () => button!.click()); }, close: async () => {await act(async () => root.unmount()); element.remove();}};
}

it("uses one panel per Adapter and lazily walks workspace → owning session → object", async () => {
  const {api, get, list} = fixture(); const view = await mount(api);
  try {
    expect(view.element.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(view.element.querySelectorAll('select[aria-label="实例与配置"] option')).toHaveLength(2);
    expect(list.mock.calls.map(call => call[0].level)).toEqual(["workspaces"]);
    expect(get).not.toHaveBeenCalled(); expect(view.element.textContent).not.toContain("接收会话 Y");
    await view.click("研究工作区"); expect(list.mock.lastCall?.[0]).toMatchObject({level: "sessions", workspaceId: "work"});
    await view.click("接收会话 Y"); expect(list.mock.lastCall?.[0]).toMatchObject({level: "objects", ownerSessionId: "Y"});
    expect(get).not.toHaveBeenCalled();
    await view.click("来自 X 的引用"); expect(get).toHaveBeenCalledWith(scope, "reference", expect.any(AbortSignal));
    expect(view.element.textContent).toContain("有限选区内容");
    expect(view.element.textContent).not.toContain("保存编辑"); expect(view.element.textContent).not.toContain("删除对象");
    expect(view.element.querySelector("textarea")).toBeNull();
    await view.click("打开所属会话"); expect(view.open).toHaveBeenCalledWith("Y");
    await view.click("关联会话 X"); expect(view.open).toHaveBeenLastCalledWith("X");
  } finally {await view.close();}
});

it("keeps unavailable members metadata-only even when another member is ready", async () => {
  const {api, get, list} = fixture();
  list.mockImplementation(async query => ({level: query.level, items: query.level === "workspaces" ? [group("workspace", "work", "研究工作区")] : query.level === "sessions" ? [group("session", "Y", "接收会话 Y")] : [{...object, unavailableReason: "引用插件已停用"}], nextCursor: null}));
  const view = await mount(api);
  try {await view.click("研究工作区"); await view.click("接收会话 Y"); await view.click("来自 X 的引用"); expect(view.element.textContent).toContain("引用插件已停用"); expect(get).not.toHaveBeenCalled();}
  finally {await view.close();}
});

it("cancels a stale directory request on instance change", async () => {
  const {api} = fixture(); let resolveOld!: (page: ExtensionDirectoryPage) => void; let oldSignal: AbortSignal | undefined;
  api.listExtensionDirectory = vi.fn((query, signal): Promise<ExtensionDirectoryPage> => {
    if (query.instanceId === "copy") {oldSignal = signal; return new Promise<ExtensionDirectoryPage>(resolve => {resolveOld = resolve;});}
    return Promise.resolve({level: "workspaces", items: [group("workspace", "main-work", "主实例工作区")], nextCursor: null});
  });
  const view = await mount(api);
  try {
    const select = view.element.querySelector('select[aria-label="实例与配置"]') as HTMLSelectElement;
    await act(async () => {select.value = JSON.stringify(["main", "web"]); select.dispatchEvent(new Event("change", {bubbles: true}));});
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => resolveOld({level: "workspaces", items: [group("workspace", "old", "过期工作区")], nextCursor: null}));
    expect(view.element.textContent).toContain("主实例工作区"); expect(view.element.textContent).not.toContain("过期工作区");
  } finally {await view.close();}
});

it("loads disclosure records beneath their graph only after expanding the disclosure", async () => {
  const {api, get, list} = fixture();
  const graphMember = {...member, scope: {...scope, namespace: "thoughtdag"}};
  api.listExtensionBusinessPanels = async () => [{...panel, adapterId: "thoughtdag", label: "ThoughtDAG", members: [graphMember]}];
  const graphObject = {...object, scope: graphMember.scope, kind: "graph", count: 1};
  list.mockImplementation(async query => ({level: query.level, items: query.level === "workspaces" ? [group("workspace", "work", "研究工作区")] : query.level === "sessions" ? [group("session", "Y", "接收会话 Y")] : query.parentObjectId ? [{...graphObject, id: "log", objectId: "log", parentObjectId: "reference", label: "读取位置记录", kind: "disclosure-log", count: 0}] : [graphObject], nextCursor: null}));
  const view = await mount(api);
  try {
    await view.click("研究工作区"); await view.click("接收会话 Y"); await view.click("来自 X 的引用");
    expect(get).toHaveBeenCalledTimes(1); expect(list.mock.calls.some(call => call[0].parentObjectId)).toBe(false);
    const details = view.element.querySelector(".extension-attached-records") as HTMLDetailsElement;
    await act(async () => {details.open = true; details.dispatchEvent(new Event("toggle"));});
    expect(list.mock.lastCall?.[0]).toMatchObject({ownerSessionId: "Y", parentObjectId: "reference"});
    expect(view.element.textContent).toContain("读取位置记录"); expect(get).toHaveBeenCalledTimes(1);
  } finally {await view.close();}
});
