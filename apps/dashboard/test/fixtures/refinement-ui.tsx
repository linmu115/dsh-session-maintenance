import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { BusinessPage, CanonicalWorkspaceDirectory } from "@linmu/dsh-session-contracts";
import { WorkspaceDirectory } from "../../src/workspace-directory.js";
import { BusinessPages } from "../../src/business-pages.js";
import "@linmu/dsh-session-ui/styles.css";
import "../../src/dashboard.css";
const at = "2026-09-18T00:00:00Z";
const directory = { schemaVersion:1, workspaces:[{workspace:{id:"research", name:"研究项目",parentId:null,sortKey:"a"},sessions:[{session:{id:"demo",title:"示例会话",originKind:"maintenance-native",updatedAt:at}}]},{workspace:{id:"writing",name:"写作项目",parentId:null,sortKey:"b"},sessions:[{session:{id:"draft",title:"示例草稿",originKind:"maintenance-native",updatedAt:at}}]}],unclassified:[] } as unknown as CanonicalWorkspaceDirectory;
const page: BusinessPage = {owner:{instanceId:"synthetic-instance",profileId:"web",namespace:"obsidian",providerId:"binding",bootId:"550e8400-e29b-41d4-a716-446655440000"},online:true,updatedAt:1,expiresAt:9999999999999,snapshot:{title:"Obsidian Vault 绑定",revision:1,sections:[
{id:"help",kind:"summary",title:"Obsidian 连接",text:"选择文件夹后，在 Obsidian 中打开该 Vault 并启用 Bridge。已绑定其他实例时请使用改绑操作。"},
{id:"vaults",kind:"key-values",title:"Vault",items:[{label:"示例笔记库",value:"synthetic-vault-0001 · 已绑定 / READY · synthetic-instance-0000-0000-0000-0000 · 修订 1"}]},
{id:"actions",kind:"actions",title:"绑定管理",actions:[{id:"bind",label:"选择文件夹并绑定",fields:[],expectedRevision:1},{id:"unbind",label:"解除绑定：示例笔记库",fields:[],expectedRevision:1}]}
]}};
function App(){const [section,setSection]=useState('扩展');const [status,setStatus]=useState('');return <div className="dsm-app-shell"><header style={{gridColumn:'1 / -1',padding:16,borderBottom:'1px solid var(--dsm-border)'}}>会话维护 · 合成预览</header><nav className="dsm-nav">{['会话','同步','扩展','设置'].map(name=><button className="dsm-nav-button" data-active={section===name} onClick={()=>setSection(name)} key={name}>{name}</button>)}</nav><main style={{padding:28,minWidth:0}}>{section==='会话'?<WorkspaceDirectory directory={directory} onOpenSession={id=>setStatus(id)} />:<BusinessPages api={{listBusinessPages:async()=>({pages:[page]})}} registeredPages={[page]} renderDirectory={()=>null} />}{status&&<p>已打开：{status}</p>}</main></div>}
createRoot(document.getElementById('root')!).render(<App />);
