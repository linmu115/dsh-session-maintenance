// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ExtensionPageView, type ExtensionPageApi } from "../src/extension-page.js";
import type { ExtensionPanel } from "@linmu/dsh-session-contracts";

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
  const api={listExtensionPanels:async()=>[panel],listExtensionObjects:async()=>({items:[object],nextCursor:null}),getExtensionObject:get,writeExtensionObject:write,resolveExtensionConflict:resolve} as unknown as ExtensionPageApi;
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
