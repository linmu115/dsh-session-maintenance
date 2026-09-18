import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CanonicalSessionEngine } from '@linmu/dsh-canonical-session-engine';
import type { CanonicalEventV1, LogicalSessionId, ProjectionRun } from '@linmu/dsh-session-contracts';
import { MaintenanceWriteCoordinator, openMaintenanceDatabase, SqliteCanonicalProjectionSource, SqliteCanonicalSessionEngineStore, SqliteInstanceWorkspacePolicyRepository, ZstdContentObjectStore } from '@linmu/dsh-session-store';
import { InstanceWorkspaceRuntime } from '../src/instance-workspace-runtime.js';

const at='2026-09-18T00:00:00.000Z';
const disposers: (()=>Promise<void>)[]=[];
afterEach(async()=>{for(const dispose of disposers.splice(0))await dispose();});
function event(id:string, sequence=0, platform:'codex'|'dsh'='codex'):CanonicalEventV1 {
  return {schemaVersion:1,id:`event-${id}-${sequence}`,logicalSessionId:id as LogicalSessionId,sequence,kind:'user-message',role:'user',content:{text:id},
    source:{platform,instanceId:'synthetic',sessionId:id,eventId:String(sequence),cursor:String(sequence)},contentDigest:`sha256:${id}-${sequence}`,rawPayload:null,extensions:{}};
}
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'dsh-sm-instance-runtime-fixture-'));
  await writeFile(join(root,'.synthetic-fixture'),'Instance scope fixture; no native homes\n');
  const db=openMaintenanceDatabase(join(root,'metadata.sqlite')), writes=MaintenanceWriteCoordinator.acquire(root), objects=new ZstdContentObjectStore(root);
  disposers.push(async()=>{db.close();writes.close();await rm(root,{recursive:true,force:true});});
  const online=new Set<string>();
  const runtime=new InstanceWorkspaceRuntime(db,[],writes,id=>online.has(id)), policies=runtime.policies, service=runtime.createService();
  const source=new SqliteCanonicalProjectionSource(db,objects), engine=new CanonicalSessionEngine(new SqliteCanonicalSessionEngineStore(db,objects));
  db.prepare("INSERT INTO adapter_registrations VALUES ('adapter-fixture','{}','fixture',1,?,?)").run(at,at);
  for(const [id,parent] of [['parent',null],['a','parent'],['b',null]] as const)
    db.prepare('INSERT INTO logical_workspaces(id,parent_id,name,sort_key,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id,parent,id,id,at,at);
  for(const id of ['a','b','unassigned']) {
    await engine.observeCodex({logicalSessionId:id as never,title:id,tags:[],archivedAt:null,workspaceId:id==='unassigned'?null:id as never,events:[event(id)],sourceCursor:'0',observedAt:at});
  }
  const run=(id:string,state:ProjectionRun['state']='preparing'):ProjectionRun=>{
    db.prepare(`INSERT INTO projection_runs(id,lease_id,branch_id,instance_id,profile_id,dsh_version,adapter_id,state,started_at,heartbeat_at) VALUES (?,?,'main','i-one','web','0.1.5-rc.2','adapter-fixture',?,?,?)`).run(id,'lease-'+id,state,at,at);
    return {schemaVersion:1,id:id as never,leaseId:('lease-'+id) as never,branchId:'main' as never,instanceId:'i-one',profileId:'web',dshVersion:'0.1.5-rc.2',adapterId:'adapter-fixture' as never,state,startedAt:at,heartbeatAt:at,checkpointId:null};
  };
  return {root,db,writes,objects,online,runtime,policies,service,source,engine,run};
}

it('freezes scope before projection; later saves affect only the next run, with empty and unassigned selections',async()=>{
  const f=await fixture();
  f.policies.updatePolicy('i-one',{expectedRevision:0,selection:{kind:'ids',workspaceIds:['a' as never],includeUnassigned:false}});
  const first=f.run('first'), projected=await f.source.load(first);
  expect(projected.sessions.map(x=>x.session.id)).toEqual(['a']);
  expect(projected.workspaces.map(x=>x.id).sort()).toEqual(['a','parent']);
  f.policies.updatePolicy('i-one',{expectedRevision:1,selection:{kind:'ids',workspaceIds:[],includeUnassigned:false}});
  expect((await f.source.loadSessions({...first,state:'running'},['a','b'] as never)).sessions.map(x=>x.session.id)).toEqual(['a']);
  expect(new SqliteInstanceWorkspacePolicyRepository(f.db).policyForRun({...first,state:'recovering'}).revision).toBe(1);
  expect((await f.service.get('i-one')).pendingActivation).toBe(true);
  f.db.prepare("UPDATE projection_runs SET state='closed' WHERE id=?").run(first.id);
  const second=f.run('second');expect((await f.source.load(second)).sessions).toEqual([]);
  f.policies.updatePolicy('i-one',{expectedRevision:2,selection:{kind:'ids',workspaceIds:[],includeUnassigned:true}});
  f.db.prepare("UPDATE projection_runs SET state='closed' WHERE id=?").run(second.id);
  expect((await f.source.load(f.run('third'))).sessions.map(x=>x.session.id)).toEqual(['unassigned']);
  expect(f.db.prepare('SELECT COUNT(*) AS count FROM logical_sessions').get()).toMatchObject({count:3});
  expect((await f.service.get('i-one')).pendingActivation).toBe(false);
});

it('keeps pre-upgrade recovery at all scope, without configuration reads freezing a preparing candidate',async()=>{
  const f=await fixture();const legacy=f.run('legacy','running');
  f.policies.updatePolicy('i-one',{expectedRevision:0,selection:{kind:'ids',workspaceIds:[],includeUnassigned:false}});
  expect(f.policies.policyForRun(legacy).selection).toEqual({kind:'all'});
  const candidate=f.run('candidate','quarantined');
  await f.service.get('i-one');
  expect(f.db.prepare('SELECT COUNT(*) AS count FROM projection_run_workspace_scopes').get()).toMatchObject({count:0});
  expect((await f.source.load({...candidate,state:'preparing'})).sessions).toEqual([]);
});

it('distinguishes selected offline, missing mapping, available, excluded, deleted, and not found sessions',async()=>{
  const f=await fixture();f.policies.updatePolicy('i-one',{expectedRevision:0,selection:{kind:'ids',workspaceIds:['a' as never],includeUnassigned:false}});
  const run=f.run('status');await f.source.load(run);
  expect((await f.service.sessionAvailability('i-one','a','web')).status).toBe('offline');
  f.online.add(run.id);
  expect((await f.service.sessionAvailability('i-one','a','web')).status).toBe('mapping-pending');
  f.db.prepare("INSERT INTO projection_sessions(run_id,native_session_id,logical_session_id,base_version_id,mode,native_revision) VALUES (?,'native-a','a',NULL,'codex-read-until-write',0)").run(run.id);
  expect(await f.service.sessionAvailability('i-one','a','web')).toMatchObject({status:'available',nativeSessionId:'native-a'});
  expect((await f.service.sessionAvailability('i-one','b','web')).status).toBe('not-synced');
  f.db.prepare("UPDATE logical_sessions SET tombstoned_at=? WHERE id='b'").run(at);
  expect((await f.service.sessionAvailability('i-one','b','web')).status).toBe('deleted');
  expect((await f.service.sessionAvailability('i-one','missing','web')).status).toBe('not-found');
});

it('guards canonical writes again after an async body write, retaining original head and no receipt when membership changes',async()=>{
  const f=await fixture();f.policies.updatePolicy('i-one',{expectedRevision:0,selection:{kind:'ids',workspaceIds:['a' as never],includeUnassigned:false}});
  const run=f.run('commit');await f.source.load(run);
  const head=f.db.prepare("SELECT head_version_id FROM logical_sessions WHERE id='a'").get()!.head_version_id as string;
  f.db.prepare("INSERT INTO projection_sessions(run_id,native_session_id,logical_session_id,base_version_id,mode,native_revision) VALUES (?,'native-a','a',?,'codex-read-until-write',0)").run(run.id,head);
  const store=new SqliteCanonicalSessionEngineStore(f.db,{put:async bytes=>{
    const result=await f.objects.put(bytes);f.db.prepare("UPDATE workspace_memberships SET workspace_id='b' WHERE logical_session_id='a'").run();return result;
  },get:key=>f.objects.get(key)} as never,undefined,undefined,f.runtime.assertMutationAllowed);
  const engine=new CanonicalSessionEngine(store);
  await expect(engine.appendDsh({logicalSessionId:'a' as never,derivedLogicalSessionId:'child-a' as never,baseVersionId:head as never,title:'a',tags:[],archivedAt:null,workspaceId:'a' as never,
    appendedEvents:[event('a',1,'dsh')],observedAt:at,projection:{runId:run.id,leaseId:run.leaseId,branchId:run.branchId,adapterId:run.adapterId,nativeSessionId:'native-a' as never,operationId:'op-a' as never,nativeRevision:1}})).rejects.toMatchObject({code:'SESSION_NOT_SYNCED'});
  expect(f.db.prepare("SELECT head_version_id FROM logical_sessions WHERE id='a'").get()).toMatchObject({head_version_id:head});
  expect(await store.getOperationReceipt('op-a' as never)).toBeUndefined();
  expect(await store.getSession('child-a' as never)).toBeUndefined();
});
