// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { InstanceWorkspaceConfiguration } from "@linmu/dsh-session-contracts";
import { InstanceWorkspacePage, type InstanceWorkspaceApi } from "../src/instance-workspace-page.js";
let container: HTMLDivElement, root: Root;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
function configuration(instanceId: string, revision = 1): InstanceWorkspaceConfiguration {
  return { policy: { schemaVersion: 1, instanceId, revision, selection: { kind: "all" }, updatedAt: "2026-09-18T00:00:00Z" }, activeScopes: [{ profileId: "web", runId: "run", policyRevision: 1, selection: { kind: "all" } }], workspaces: [{ id: "work" as never, name: `工作区-${instanceId}`, deleted: false }], pendingActivation: revision !== 1 };
}
const directory = async () => ({ instances: [{ instanceId: "one", name: "实例一" }, { instanceId: "two", name: "实例二" }] });
async function render(api: InstanceWorkspaceApi) { await act(async () => root.render(<InstanceWorkspacePage api={api} />)); }
async function click(label: string) { const item = [...container.querySelectorAll("button, label")].find(item => item.textContent === label); if (!item) throw new Error(`Missing ${label}`); await act(async () => (item instanceof HTMLLabelElement ? item.querySelector("input")! : item as HTMLElement).click()); }
async function submit() { await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); }
it("saves explicit empty selection without rewriting current active scope", async () => {
  const save = vi.fn(async (id, input) => ({ ...configuration(id, 2), policy: { ...configuration(id, 2).policy, selection: input.selection } }));
  await render({ listInstanceWorkspaceInstances: directory, getInstanceWorkspaceSync: async id => configuration(id), saveInstanceWorkspaceSync: save });
  await click("编辑"); await click("仅同步以下选择");
  expect(container.textContent).toContain("下次启动不向此实例同步任何会话");
  await submit();
  expect(save).toHaveBeenCalledWith("one", { expectedRevision: 1, selection: { kind: "ids", workspaceIds: [], includeUnassigned: false } }, expect.any(AbortSignal));
  expect(container.textContent).toContain("生效修订 1");
  expect(container.textContent).toContain("等待下次启动");
  expect(container.textContent).toContain("已保存 · 下次启动生效");
});
it("keeps distinct online runs visible even when profile, revision and scope match", async () => {
  const value = configuration("one");
  value.activeScopes.push({ ...value.activeScopes[0]!, runId: "another-run" });
  await render({ listInstanceWorkspaceInstances: directory, getInstanceWorkspaceSync: async () => value });
  const current = container.querySelector('[aria-label="当前运行范围"]')!;
  expect(current.textContent).toContain("查看 2 条运行范围");
  expect(current.querySelector<HTMLDetailsElement>(".instance-scope-details")!.open).toBe(false);
  const scopes = [...current.querySelectorAll<HTMLDetailsElement>(".instance-active-scopes > details")];
  expect(scopes).toHaveLength(2);
  expect(scopes.map(scope => scope.querySelector("code")!.textContent)).toEqual(["run", "another-run"]);
  expect(scopes.every(scope => !scope.open)).toBe(true);
});
it("reloads a 409 policy conflict and requires a fresh choice before another save", async () => {
  let reads = 0;
  await render({ listInstanceWorkspaceInstances: directory, getInstanceWorkspaceSync: async id => configuration(id, ++reads), saveInstanceWorkspaceSync: async () => { throw Object.assign(new Error("名单冲突"), { status: 409 }); } });
  await click("编辑"); await click("仅同步以下选择"); await submit();
  expect(reads).toBe(2); expect(container.textContent).toContain("已重新读取最新范围");
  expect(container.textContent).toContain("修订 2");
  expect(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.checked).toBe(true);
  expect(container.textContent).toContain("你的勾选已保留");
});
it("aborts and ignores a late response when the user selects a different instance", async () => {
  let resolve!: (value: InstanceWorkspaceConfiguration) => void, oldSignal: AbortSignal | undefined;
  const old = new Promise<InstanceWorkspaceConfiguration>(done => { resolve = done; });
  await render({ listInstanceWorkspaceInstances: directory, getInstanceWorkspaceSync: async (id, signal) => { if (id === "one") { oldSignal = signal; return old; } return configuration(id); } });
  await act(async () => { const select = container.querySelector("select")!; select.value = "two"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => resolve(configuration("one")));
  expect(container.querySelector("select")!.value).toBe("two");
  await click("编辑"); await click("仅同步以下选择"); expect(container.textContent).toContain("工作区-two"); expect(container.textContent).not.toContain("工作区-one");
});
it("saves unassigned-only explicitly and discards an old-instance save response after navigation", async () => {
  let resolve!: (value: InstanceWorkspaceConfiguration) => void, saveSignal: AbortSignal | undefined;
  const pending = new Promise<InstanceWorkspaceConfiguration>(done => { resolve = done; });
  const save = vi.fn(async (_id, _update, signal) => { saveSignal = signal; return pending; });
  await render({ listInstanceWorkspaceInstances: directory, getInstanceWorkspaceSync: async id => configuration(id), saveInstanceWorkspaceSync: save });
  await click("编辑"); await click("仅同步以下选择"); await click("包含未分组会话"); await submit();
  expect(save.mock.calls[0]?.[1]).toEqual({ expectedRevision: 1, selection: { kind: "ids", workspaceIds: [], includeUnassigned: true } });
  await act(async () => { const select = container.querySelector("select")!; select.value = "two"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(saveSignal?.aborted).toBe(true);
  await act(async () => resolve(configuration("one", 9)));
  expect(container.textContent).not.toContain("修订 9");
  expect(container.querySelector("select")!.value).toBe("two");
});

it("shows Launcher names, collapses legacy identities, and keeps historical scopes accessible", async () => {
  const save=vi.fn();
  await render({listInstanceWorkspaceInstances:async()=>({instances:[{instanceId:'one',name:'0.1.5-rc.2 副本'},{instanceId:'two',name:'0.1.5-rc.2 测试'}],historicalInstances:[{instanceId:'legacy',name:'旧手工登记'}]}),getInstanceWorkspaceSync:async id=>configuration(id),saveInstanceWorkspaceSync:save});
  const labels=[...container.querySelectorAll('select option')].map(item=>item.textContent);
  expect(labels).toContain('0.1.5-rc.2 副本');expect(labels).toContain('0.1.5-rc.2 测试');expect(labels).not.toContain('旧手工登记');
  const history=container.querySelector<HTMLDetailsElement>('.historical-instance-list')!;
  expect(history.open).toBe(false);
  await act(async()=>{history.open=true;});await click('旧手工登记');
  await click('编辑');await click('仅同步以下选择');expect(container.textContent).toContain('工作区-legacy');
  expect(save).not.toHaveBeenCalled();
});
it('allows a direct checkbox choice without first entering edit mode and only writes on save',async()=>{
  const save=vi.fn(async(id,input)=>({...configuration(id),activeScopes:[],pendingActivation:false,policy:{...configuration(id).policy,selection:input.selection}}));
  await render({listInstanceWorkspaceInstances:directory,getInstanceWorkspaceSync:async id=>({...configuration(id),activeScopes:[]}),saveInstanceWorkspaceSync:save});
  const box=container.querySelector<HTMLInputElement>('[aria-label="同步 工作区-one"]')!;
  expect(box.disabled).toBe(false);
  await act(async()=>box.click());expect(box.checked).toBe(false);expect(save).not.toHaveBeenCalled();
  await submit();expect(save).toHaveBeenCalledTimes(1);expect(container.textContent).toContain('已保存同步范围');
  expect(container.textContent).not.toContain('实例当前没有在线运行');
});

it("disambiguates duplicate Launcher names by stable identity", async () => {
  await render({listInstanceWorkspaceInstances:async()=>({instances:[{instanceId:'one',name:'测试'},{instanceId:'two',name:'测试'}]}),getInstanceWorkspaceSync:async id=>configuration(id)});
  const labels=[...container.querySelectorAll('select option')].map(item=>item.textContent);
  expect(labels).toContain('测试 · one');expect(labels).toContain('测试 · two');
});

it("starts collapsed, keeps a draft when collapsed, and changes all to an explicit Maintenance list", async () => {
  const save = vi.fn(async (id, input) => ({ ...configuration(id, 2), policy: { ...configuration(id, 2).policy, selection: input.selection } }));
  await render({ listInstanceWorkspaceInstances: directory, getInstanceWorkspaceSync: async id => configuration(id), saveInstanceWorkspaceSync: save });
  const list = container.querySelector<HTMLDetailsElement>(".maintenance-source-list")!;
  expect(list.open).toBe(false);
  await act(async () => { list.open = true; list.dispatchEvent(new Event("toggle")); });
  await click("编辑");
  const workspace = container.querySelector<HTMLInputElement>('[aria-label="同步 工作区-one"]')!;
  expect(workspace.checked).toBe(true);
  await act(async () => workspace.click());
  expect(workspace.checked).toBe(false);
  await act(async () => { list.open = false; list.dispatchEvent(new Event("toggle")); });
  expect(list.querySelector("summary")!.textContent).toContain("有未保存的更改");
  expect(save).not.toHaveBeenCalled();
  await act(async () => { list.open = true; list.dispatchEvent(new Event("toggle")); });
  await submit();
  expect(save).toHaveBeenCalledWith("one", { expectedRevision: 1, selection: { kind: "ids", workspaceIds: [], includeUnassigned: true } }, expect.any(AbortSignal));
});
