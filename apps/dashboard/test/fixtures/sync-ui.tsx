import { createRoot } from 'react-dom/client';
import { SyncSettingsPage } from '../../src/sync-page.js';
import type { CodexProjectMappingConfiguration, InstanceWorkspaceConfiguration, CodexProjectMappingUpdate, InstanceWorkspacePolicyUpdate } from '@linmu/dsh-session-contracts';
import '@linmu/dsh-session-ui/styles.css';
import '../../src/dashboard.css';
let codex: CodexProjectMappingConfiguration = { policy:{revision:1,activeRevision:1,configured:true,activeConfigured:true,projectKeys:['p0'],activeProjectKeys:['p0'],includeFutureSessions:true},projects:Array.from({length:18},(_,i)=>({key:'p'+i,instanceId:'fixture',projectId:'p'+i,name:'合成项目 '+(i+1),roots:[],sessionCount:4,kind:'local',eligible:true,issues:[]})),issues:[],pendingActivation:false,observer:{state:'idle',lastSyncAt:null,lastError:null} };
let maintenance: InstanceWorkspaceConfiguration = { policy:{schemaVersion:1,instanceId:'fixture',revision:1,selection:{kind:'all'},updatedAt:null},activeScopes:[],workspaces:Array.from({length:18},(_,i)=>({id:('w'+i) as never,name:'工作区 '+(i+1),deleted:false})),pendingActivation:false };
const api = {
 listInstanceWorkspaceInstances:async()=>({instances:[{instanceId:'fixture',name:'合成实例'}]}),
 getInstanceWorkspaceSync:async()=>maintenance,
 saveInstanceWorkspaceSync:async(_id: string,input: InstanceWorkspacePolicyUpdate)=>{ maintenance={...maintenance,policy:{...maintenance.policy,revision:maintenance.policy.revision+1,selection:input.selection},pendingActivation:true};return maintenance },
 getCodexProjectMapping:async()=>codex,
 saveCodexProjectMapping:async(input: CodexProjectMappingUpdate)=>{codex={...codex,policy:{...codex.policy,revision:codex.policy.revision+1,projectKeys:input.projectKeys},pendingActivation:true};return codex},
};
createRoot(document.querySelector('#root')!).render(<SyncSettingsPage api={api}/>);
