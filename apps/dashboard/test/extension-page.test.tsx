// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ExtensionPageView, type ExtensionPageApi } from "../src/extension-page.js";
import type { BusinessPage, ExtensionBusinessPanel, ExtensionPanel } from "@linmu/dsh-session-contracts";

it("shows information only for its registered adapter and retains uncertain actions across category switches", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const page: BusinessPage = { owner: { instanceId: "copy", profileId: "web", namespace: "obsidian-bridge", providerId: "binding", bootId: "550e8400-e29b-41d4-a716-446655440000" }, online: true, updatedAt: 1, expiresAt: 20000,
    snapshot: { title: "Vault 接入", revision: 1, sections: [{ id: "actions", title: "绑定", kind: "actions", actions: [{ id: "bind", label: "确认绑定", expectedRevision: 4, fields: [] }] }] } };
  const enqueue = vi.fn().mockRejectedValue(new Error("response lost"));
  const panel: ExtensionBusinessPanel = { adapterId: "obsidian-series", label: "Obsidian 系列", scope: { instanceId: "copy", profileId: "web" }, instanceLabel: "Copy", profileLabel: "Web", status: "ready", members: [], objectCount: 0, conflictCount: 0, bytes: 0 };
  const directory = vi.fn(async () => ({ level: "workspaces", items: [], nextCursor: null }));
  const api = { listExtensionPanels: async () => [], listExtensionBusinessPanels: async () => [panel, { ...panel, adapterId: "thoughtdag", label: "ThoughtDAG" }], listExtensionDirectory: directory, listBusinessPages: async () => ({ pages: [page] }), enqueueBusinessPageAction: enqueue } as unknown as ExtensionPageApi;
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  const switchView = async (name: string) => act(async () => [...node.querySelectorAll("button")].find(button => button.textContent === name)!.click());
  try {
    await act(async () => root.render(<ExtensionPageView api={api} onOpenSession={() => undefined} />));
    const plugins = node.querySelector(".business-pages")!;
    expect([...node.querySelectorAll('[aria-label="扩展栏目"] button')].map(button => button.textContent)).toEqual(["Obsidian 系列", "ThoughtDAG"]);
    expect(node.querySelector('.extension-page > .extension-view-switch')).toBeNull();
    expect(plugins.closest('section[aria-label="Obsidian 系列"]')).not.toBeNull();
    expect(node.querySelectorAll('[aria-label="扩展适配器"]')).toHaveLength(0);
    expect(directory.mock.calls).toHaveLength(1);
    expect(node.querySelector(".extension-page")!.firstElementChild?.tagName).toBe("NAV");
    expect(node.querySelector(".extension-category")!.firstElementChild?.tagName).toBe("NAV");
    expect(plugins.closest("[hidden]")).not.toBeNull();
    expect([...node.querySelectorAll("h2")].find(title => title.textContent === "扩展数据")!.closest("[hidden]")).toBeNull();
    await switchView("插件信息与接入");
    expect(plugins.closest("[hidden]")).toBeNull();
    const form = plugins.querySelector("form")!;
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    const original = enqueue.mock.calls[0]![0];
    await switchView("扩展数据"); await switchView("ThoughtDAG");
    expect(plugins.closest("[hidden]")).not.toBeNull();
    const graphCategory = node.querySelector('section[aria-label="ThoughtDAG"]')!;
    expect(graphCategory.querySelector("form")).toBeNull();
    expect([...graphCategory.querySelectorAll("nav button")].map(button => button.textContent)).toEqual(["扩展数据"]);
    expect(graphCategory.querySelector(".business-pages")).toBeNull();
    await switchView("Obsidian 系列"); await switchView("插件信息与接入");
    expect(plugins.querySelector("form")).toBe(form);
    expect(plugins.textContent).toContain("同一操作编号");
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(enqueue.mock.calls[1]![0]).toEqual(original);
    expect(original).toMatchObject({ owner: page.owner, actionId: "bind", expectedRevision: 4 });
  } finally { await act(async () => root.unmount()); node.remove(); }
});

it("loads only the selected body, renders graph preview and requires an explicit conflict choice",async()=>{
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  const scope={instanceId:"copy",profileId:"web",namespace:"thoughtdag"};
  const capabilities={read:true,write:true,delete:true,restore:true,panel:true,context:false as const};
  const panel:ExtensionPanel={scope,label:"ThoughtDAG",pluginVersion:"0.4.11",writerId:"dsh-thoughtdag",configured:true,enabled:true,status:"ready",objectCount:1,conflictCount:0,bytes:20,capabilities};
  const object={scope,objectId:"canvas",writerId:panel.writerId,title:"当前画布",revision:2,schemaVersion:1,deleted:false,conflicts:0,updatedAt:"now",bytes:20,content:{schemaVersion:1,title:"当前画布",body:{nodes:[],edges:[]},references:[]}};
  const get=vi.fn().mockResolvedValue({object,summary:"1 个节点",conflictIds:[],preview:{kind:"graph",nodes:[{id:"a",label:"节点 A",x:1,y:2}],edges:[],total:1}});
  const conflict={id:"conflict",objectId:"canvas",createdAt:"now",expectedRevision:1,current:object,incoming:{scope,objectId:"canvas",writerId:panel.writerId,expectedRevision:1,deleted:false,content:{...object.content,title:"另一个编辑"}}};
  const write=vi.fn().mockResolvedValue({status:"conflict",conflict});
  const resolve=vi.fn().mockRejectedValue(new Error("对象再次发生变化，请重新检查冲突。"));
  const api={listExtensionPanels:async()=>[panel],listExtensionObjects:async function(this: ExtensionPageApi) { expect(this).toBe(api); return {items:[object],nextCursor:null}; },getExtensionObject:get,writeExtensionObject:write,resolveExtensionConflict:resolve} as unknown as ExtensionPageApi;
  const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
  const click=async(text:string)=>{const button=[...node.querySelectorAll("button")].find(b=>b.textContent===text);expect(button).toBeDefined();await act(async()=>button!.click());};
  try {
    await act(async()=>root.render(<ExtensionPageView api={api} onOpenSession={()=>undefined}/>));
    await click("查看对象");expect(get).not.toHaveBeenCalled();await click("打开");expect(get).toHaveBeenCalledTimes(1);
    expect(node.querySelector('svg[aria-label="画布节点和连线预览"]')).not.toBeNull();
    await click("保存编辑");expect(write.mock.lastCall?.[0]).toMatchObject({expectedRevision:2});
    expect(node.textContent).toContain("两份内容均已保留");expect(resolve).not.toHaveBeenCalled();
    await click("采用传入编辑");expect(resolve).toHaveBeenCalledWith(scope,"conflict",2,"incoming");expect(node.textContent).toContain("对象再次发生变化");
  } finally { await act(async()=>root.unmount());node.remove(); }
});

it("mounts dynamic scopes, pages metadata lazily and keeps unavailable bodies unloaded",async()=>{
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  const scope={instanceId:"copy",profileId:"web",namespace:"thoughtdag"};
  const panel:ExtensionPanel={scope,label:"ThoughtDAG",pluginVersion:"0.4.11",writerId:"dsh-thoughtdag",configured:false,enabled:true,status:"disabled",objectCount:65,conflictCount:0,bytes:20,capabilities:null};
  const list=vi.fn().mockResolvedValue({items:[{scope,objectId:"old",title:"已保存画布",revision:4,updatedAt:"2026-09-10",conflicts:0}],nextCursor:"old"});
  const get=vi.fn();const api={listExtensionPanels:vi.fn().mockResolvedValue([panel]),listExtensionObjects:list,getExtensionObject:get} as unknown as ExtensionPageApi;
  const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
  const click=async(text:string)=>{const button=[...node.querySelectorAll("button")].find(b=>b.textContent===text);expect(button).toBeDefined();await act(async()=>button!.click());};
  try{
    await act(async()=>root.render(<ExtensionPageView api={api} onOpenSession={()=>undefined}/>));
    expect(node.textContent).toContain("ThoughtDAG");expect(node.textContent).toContain("已停用，数据保留");expect(list).not.toHaveBeenCalled();
    await click("查看元数据");expect(node.textContent).toContain("已保存画布");expect(get).not.toHaveBeenCalled();
    await click("下一页");expect(list.mock.lastCall?.[0]).toMatchObject({after:"old",limit:30});expect(get).not.toHaveBeenCalled();
  }finally{await act(async()=>root.unmount());node.remove();}
});
