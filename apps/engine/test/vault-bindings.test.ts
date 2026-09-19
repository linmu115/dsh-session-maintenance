import { afterEach, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHmac } from "node:crypto";
import { createFixtureSandbox } from "../../../packages/test-support/src/index.js";
import { VaultBindingManager } from "../src/vault-bindings.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const fixture = await createFixtureSandbox("offline-vault-binding"); cleanups.push(fixture.cleanup);
  const root = join(fixture.root, "vault"), discovery = join(fixture.root, "discovery");
  const plugin = join(root, ".obsidian", "plugins", "obsidian-deepharness-bridge");
  await mkdir(plugin, {recursive:true}); await mkdir(discovery);
  await writeFile(join(plugin,"manifest.json"), JSON.stringify({id:"obsidian-deepharness-bridge",version:"0.7.0-rc2.4"}));
  await writeFile(join(plugin,"main.js"), "// synthetic fixture"); await writeFile(join(plugin,"data.json"), JSON.stringify({vaultId:"vault-one"}));
  const target = {instanceId:"offline-instance",profileId:"web"};
  const identity = {kind:"vault",vaultId:"vault-one",publisherId:randomUUID(),bootId:randomUUID(),origin:"http://127.0.0.1:43219",displayName:"合成 Vault",capabilities:["maintenance-vault-binding-v1"], binding:{bindingProtocolVersion:1,vaultId:"vault-one",revision:0,target:null as typeof target | null,updatedAt:1,lastOperationId:undefined as string | undefined}};
  await writeFile(join(discovery,"vault.json"),JSON.stringify({...identity,expiresAt:Date.now()+60000}));
  const picker = vi.fn(async()=>root); let drop = false;
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/discovery/v1/identity") return Response.json(identity);
    if (path === "/discovery/v1/vault-location") return Response.json({...identity,vaultRoot:root});
    if (path === "/control/v1/maintenance-binding") {
      const {payload,signature} = JSON.parse(String(init!.body));
      expect(signature).toBe(createHmac("sha256","synthetic-token").update(payload).digest("hex"));
      const grant = JSON.parse(Buffer.from(payload,"base64url").toString());
      expect(grant.expectedRevision).toBe(identity.binding.revision);
      identity.binding = {...identity.binding,revision:identity.binding.revision+1,target:grant.intent === "bind" ? target : null,lastOperationId:grant.operationId};
      if (drop) {drop=false; throw new Error("synthetic dropped reply");}
      return Response.json(identity.binding);
    }
    throw new Error("Unexpected endpoint: " + path);
  });
  const options = {stateRoot:fixture.root,token:"synthetic-token",discoveryRoot:discovery,picker,fetch:fetcher as typeof fetch,vaultRegistryFile:join(fixture.root,"obsidian.json"),instances:async()=>[{...target,name:"已登记但未启动"}]};
  return {manager:new VaultBindingManager(options),options,target,identity,picker,fetcher,plugin,root,discovery,dropNext:()=>{drop=true;}};
}
it("binds and unbinds a registered offline DSH instance, keeping Companion as writer",async()=>{
 const f=await fixture(); expect(await f.manager.instances()).toHaveLength(1);
 await f.manager.change({...f.target,operationId:randomUUID()},false,new AbortController().signal);
 const list=await f.manager.list(f.target); expect(list).toHaveLength(1); expect(list[0]).toMatchObject({vaultId:"vault-one",revision:1,manageable:true});
 await f.manager.change({...f.target,vaultId:"vault-one",expectedRevision:1,operationId:randomUUID()},true,new AbortController().signal);
 expect(await f.manager.list(f.target)).toEqual([]);
 expect(f.fetcher.mock.calls.every(([url])=> !String(url).includes("obsidian-bridge/identity"))).toBe(true);
});
it("recovers a dropped unbind reply across manager restart with the same operation",async()=>{
 const f=await fixture(); await f.manager.change({...f.target,operationId:randomUUID()},false,new AbortController().signal);
 const request={...f.target,vaultId:"vault-one",expectedRevision:1,operationId:randomUUID()};
 f.dropNext(); await expect(f.manager.change(request,true,new AbortController().signal)).rejects.toThrow();
 const restarted=new VaultBindingManager(f.options);
 await expect(restarted.change(request,true,new AbortController().signal)).resolves.toMatchObject({message:"已解除绑定"});
 expect(f.identity.binding.revision).toBe(2);
 await expect(restarted.change({...request,expectedRevision:0},true,new AbortController().signal)).rejects.toThrow("操作编号");
});
it("rejects foreign bindings, unknown instances, stale revisions and old plugins",async()=>{
 const f=await fixture(); const signal=new AbortController().signal;
 await expect(f.manager.change({...f.target,instanceId:"unknown",operationId:randomUUID()},false,signal)).rejects.toThrow("未登记"); expect(f.picker).not.toHaveBeenCalled();
 f.identity.binding.target={...f.target,instanceId:"foreign"};
 await expect(f.manager.change({...f.target,operationId:randomUUID()},false,signal)).rejects.toThrow("其他实例");
 f.identity.binding.target=f.target;
 await expect(f.manager.change({...f.target,vaultId:"vault-one",expectedRevision:9,operationId:randomUUID()},true,signal)).rejects.toThrow("其他入口");
 await writeFile(join(f.plugin,"manifest.json"),JSON.stringify({id:"obsidian-deepharness-bridge",version:"0.7.0-rc2.3"}));
 await expect(f.manager.change({...f.target,operationId:randomUUID()},false,signal)).rejects.toThrow("兼容");
});
it("cancel has no writes and duplicated Vault publishers cannot bind",async()=>{
 const f=await fixture(); f.picker.mockResolvedValueOnce(null as never);
 expect(await f.manager.change({...f.target,operationId:randomUUID()},false,new AbortController().signal)).toMatchObject({cancelled:true});
 const second={...f.identity,publisherId:randomUUID(),origin:"http://127.0.0.1:43220",expiresAt:Date.now()+60000};
 await writeFile(join(f.discovery,"duplicate.json"),JSON.stringify(second));
 const original=f.options.fetch;
 f.options.fetch=(async(url,init)=>String(url).startsWith(second.origin)?Response.json(second):original(url,init)) as typeof fetch;
 const manager=new VaultBindingManager(f.options);
 await expect(manager.change({...f.target,operationId:randomUUID()},false,new AbortController().signal)).rejects.toThrow("身份冲突");
});

it("lists pre-existing persisted Vault bindings even if both apps are offline",async()=>{
 const f=await fixture();
 await writeFile(f.options.vaultRegistryFile,JSON.stringify({vaults:{one:{path:f.root}}}));
 await writeFile(join(f.plugin,"data.json"),JSON.stringify({vaultId:"vault-one",bindingState:{snapshot:{bindingProtocolVersion:1,vaultId:"vault-one",revision:7,target:f.target,updatedAt:1}}}));
 const manager=new VaultBindingManager({...f.options,fetch:(async()=>{throw new Error("offline");}) as typeof fetch});
 expect(await manager.list(f.target)).toEqual([expect.objectContaining({vaultId:"vault-one",revision:7,online:false,manageable:false})]);
});
