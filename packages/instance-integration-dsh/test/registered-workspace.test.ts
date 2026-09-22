import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { readBoundStandaloneInstances } from '../src/standalone.js';
import { rememberJoinedWorkspace } from '../src/workspace-folders.js';
import { readWorkspaceMappings } from '../src/workspace-mapping-store.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'SYNTHETIC-workspace-registration-'));roots.push(root);return root;}
it('ignores an older directory profile in favor of the saved directory binding',async()=>{
  const root=await fixture(),base={schemaVersion:1,instanceId:'one',name:'test',runtimeVersion:'0.1.5-rc.2',homeRoot:root,versionRoot:root,runtimeUrl:'http://127.0.0.1:1234'};
  await writeFile(join(root,'standalone-instances.json'),JSON.stringify([{...base,profileId:'web'},{...base,profileId:'declared'}]));
  await writeFile(join(root,'instance-integrations.json'),JSON.stringify({schemaVersion:1,bindings:[{targetId:'target',kind:'dsh',instanceId:'one',profileId:'declared',connectionKind:'directory',launcherDataRoot:null,runtimeVersion:'0.1.5-rc.2',adapterId:'dsh-0.1.5',fingerprint:'hash',checkedAt:'2026-09-22T00:00:00Z'}]}));
  expect((await readBoundStandaloneInstances(root)).map(row=>row.profileId)).toEqual(['declared']);
});
it('remembers an empty native workspace path and refuses unknown or conflicting paths',async()=>{
  const root=await fixture(),home=join(root,'home'),path=join(root,'workplace1');await mkdir(join(home,'storages'),{recursive:true});
  await writeFile(join(home,'storages/workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},tables:{workspaces:{native:{path}}}}));
  const input={stateRoot:root,homeRoot:home,endpointId:'one',workspaceId:'joined',path};
  await rememberJoinedWorkspace(input);await rememberJoinedWorkspace(input);
  expect(await readWorkspaceMappings(root,'one')).toEqual([{workspaceId:'joined',folder:'workplace1',path,owned:true}]);
  await expect(rememberJoinedWorkspace({...input,workspaceId:'other'})).rejects.toMatchObject({code:'SYNC_WORKSPACE_PATH_CONFLICT'});
  await expect(rememberJoinedWorkspace({...input,path:join(root,'unknown')})).rejects.toMatchObject({code:'WORKSPACE_JOIN_PATH_UNREGISTERED'});
});
