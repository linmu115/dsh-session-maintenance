// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { VaultBindingPage } from "../src/vault-binding-page.js";
it("shows registered instances without a running provider and manages bindings in a modal",async()=>{
 (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 const instance={instanceId:"offline",profileId:"web",name:"离线实例"};
 const create=vi.fn().mockRejectedValueOnce(new Error("响应丢失")).mockResolvedValue({message:"已绑定"});
 const remove=vi.fn(async(_input: unknown)=>({message:"已解绑"}));
 const api={listVaultBindingInstances:vi.fn(async()=>[instance]),listManagedVaults:vi.fn(async()=>[{vaultId:"vault",name:"Vault A",root:"fixture",revision:4,online:true,manageable:true}]),createVaultBinding:create,removeVaultBinding:remove};
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
 const click=async(text:string)=>{await act(async()=>{[...node.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent===text)!.click();});};
 try {
  await act(async()=>root.render(<VaultBindingPage api={api}/>)); expect(api.listManagedVaults).not.toHaveBeenCalled();
  await click("离线实例web"); expect(node.querySelector('dialog')?.hasAttribute("open")).toBe(true); expect(node.textContent).toContain("Vault A");
  await click("新建绑定"); expect(node.textContent).toContain("响应丢失");
  await click("重试同一操作"); expect(create.mock.calls[1]![0]).toEqual(create.mock.calls[0]![0]);
  await click("解绑"); expect(remove.mock.calls[0]![0]).toMatchObject({instanceId:"offline",profileId:"web",vaultId:"vault",expectedRevision:4});
 } finally {await act(async()=>root.unmount());node.remove();}
});
