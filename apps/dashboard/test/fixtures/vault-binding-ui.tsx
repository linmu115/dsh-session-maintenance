import { createRoot } from "react-dom/client";
import { ExtensionPageView } from "../../src/extension-page.js";
import type { ExtensionPageApi } from "../../src/extension-page.js";
import type { ManagedVault, VaultBindingAction } from "@linmu/dsh-session-contracts";
import "@linmu/dsh-session-ui/styles.css";
import "../../src/dashboard.css";
let vaults: ManagedVault[] = [{vaultId:"fixture-vault",name:"研究笔记",root:"C:/合成示例/研究笔记",revision:1,online:true,manageable:true}];
const api = {
 listExtensionPanels:async()=>[],listExtensionBusinessPanels:async()=>[],listBusinessPages:async()=>({pages:[]}),
 listExtensionDirectory:async()=>({items:[],nextCursor:null}),
 listVaultBindingInstances:async()=>[{instanceId:"fixture-one",profileId:"web",name:"研究用实例"},{instanceId:"fixture-two",profileId:"web",name:"日常实例"}],
 listManagedVaults:async(target:{instanceId:string})=>target.instanceId==="fixture-one"?vaults:[],
 createVaultBinding:async()=>{vaults=[...vaults,{vaultId:crypto.randomUUID(),name:"新建示例 Vault",root:"C:/合成示例/新 Vault",revision:1,online:true,manageable:true}];return {message:"合成验收：已模拟选择文件夹并绑定，未访问真实文件夹"};},
 removeVaultBinding:async(input:VaultBindingAction)=>{vaults=vaults.filter(vault=>vault.vaultId!==input.vaultId);return {message:"已解除合成绑定"};},
} as unknown as ExtensionPageApi;
createRoot(document.querySelector("#root")!).render(<ExtensionPageView api={api} onOpenSession={()=>{}}/>);
