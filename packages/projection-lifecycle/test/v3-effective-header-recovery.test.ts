import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalProjectionSessionInput, JsonValue, OperationId, ProjectionOperationReceipt, ProjectionRun, ProjectionRunRepository, ProjectionRunState, ProjectionSession, RunId } from '@linmu/dsh-session-contracts';
import { MemoryStatusEventAdapter, StatusLog } from '@linmu/dsh-session-status-log';
import { adapter, normalizeV3Append, recoverV3RuntimeTail, v3NativeSessionCodec, v3NativeSessionId, V3RuntimeBridge } from '../../adapter-dsh-0-1-5/src/index.js';
import { contextEvents, contextHeader } from '../../adapter-dsh-0-1-5/test/context-fixture.js';
import { JsonProjectionDirectory, ProjectionLifecycle } from '../src/index.js';

const at='2026-09-13T00:00:00.000Z', roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
class MemoryRuns implements ProjectionRunRepository {
  readonly runs=new Map<string,ProjectionRun>();readonly sessions=new Map<string,ProjectionSession>();readonly receipts=new Map<string,ProjectionOperationReceipt>();
  async createProjectionRun(run:ProjectionRun){this.runs.set(run.id,run);return run;}
  async getProjectionRun(id:RunId){return this.runs.get(id);}
  async setProjectionRunState(id:RunId,state:ProjectionRunState){this.runs.set(id,{...this.runs.get(id)!,state});}
  async setProjectionRunCheckpoint(id:RunId,checkpointId:string){this.runs.set(id,{...this.runs.get(id)!,checkpointId:checkpointId as never});}
  async listProjectionSessions(id:RunId){return [...this.sessions.values()].filter(s=>s.runId===id);}
  async upsertProjectionSession(session:ProjectionSession){this.sessions.set(`${session.runId}:${session.nativeSessionId}`,session);}
  async saveOperationReceipt(receipt:ProjectionOperationReceipt){this.receipts.set(receipt.operationId,receipt);}
  async getOperationReceipt(id:OperationId){return this.receipts.get(id);}
}
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'dsh-v3-effective-header-synthetic-'));roots.push(root);
  const logicalId='effective-header-source',nativeId=v3NativeSessionId(logicalId as never),sourceHeader={...contextHeader,cwd:join(root,'missing-source-project')};
  const prefix=contextEvents(false);
  const normalized=await normalizeV3Append({runId:'source-run' as never,nativeSessionId:contextHeader.id as never,operationId:'source-op' as never,
    nativeRevision:prefix.length,observedAt:at,payload:{logicalSessionId:logicalId,instanceId:'synthetic-source',header:sourceHeader,inheritedEventCount:0,events:prefix}});
  const item:CanonicalProjectionSessionInput={session:{schemaVersion:1,id:logicalId as never,authorityScope:'maintenance',originKind:'maintenance-native',headVersionId:'base-version' as never,
    title:'Synthetic recovery source',tags:[],archivedAt:null,tombstonedAt:null,createdAt:at,updatedAt:at},events:normalized.events,workspaceId:null};
  const originalSource=JSON.stringify(item),runs=new MemoryRuns(),observedHeaders:JsonValue[]=[];
  const appendDsh=vi.fn(async(input:any)=>({outcome:'advanced' as const,operationId:input.projection.operationId,logicalSessionId:input.logicalSessionId,
    versionId:'tail-version' as never,tombstoneState:null,committedAt:at}));
  let counter=0;
  const lifecycle=()=>new ProjectionLifecycle({runRepository:runs,source:{load:async run=>({run,workspaces:[],sessions:[item]})},
    adapter:{...adapter,async inspect(reader){const payload=await reader.readSession(nativeId) as Record<string,JsonValue>;observedHeaders.push(payload.header!);return adapter.inspect(reader);}},
    bridge:new V3RuntimeBridge({attach:async()=>({registrationId:`synthetic-${++counter}`,attachedAt:at}),drain:async(_id,runId)=>({runId,pendingOperations:0,receipts:[]}),detach:async()=>{}}),
    canonicalEngine:{appendDsh},checkpointRepository:{saveCheckpoint:async()=>{}},statusLog:new StatusLog(new MemoryStatusEventAdapter(),{clock:()=>at,idFactory:kind=>`${kind}-${++counter}`}),
    runtimeRoot:join(root,'runtime'),clock:()=>at,idFactory:kind=>`${kind}-${++counter}`});
  const initial=lifecycle(),prepared=await initial.prepareRun({instanceId:'synthetic-rc2',profileId:'web',dshVersion:'0.1.5-rc.2',branchId:'main' as never,
    maintenanceEndpoint:'http://127.0.0.1:41781',runtimeBroker:{ownerClientId:'synthetic-owner',runtimeClientId:'synthetic-host'}});
  await initial.attachRun(prepared);
  const directory=new JsonProjectionDirectory(prepared.projectionRoot),payload=await directory.readSession(nativeId) as Record<string,JsonValue>;
  const catalog=await directory.readSessionCatalog(prepared.run.id),registered=catalog.sessions[0]!.payload as Record<string,JsonValue>;
  const effective=registered.header!;
  expect(effective).not.toEqual(payload.header);expect((effective as Record<string,JsonValue>).cwd).not.toBe(sourceHeader.cwd);
  const artifacts=await v3NativeSessionCodec.inspect(prepared.nativeSpace!.root),artifact=artifacts[0]!;
  const file=join(prepared.nativeSpace!.root,artifact.relativePath);
  const recover=async()=>lifecycle().recover(prepared.run.id,async({sessions})=>recoverV3RuntimeTail({runId:prepared.run.id,persistenceRoot:prepared.nativeSpace!.root,observedAt:at,
    sessions:sessions.map(s=>({nativeSessionId:s.projection.nativeSessionId,logicalSessionId:s.projection.logicalSessionId,baseVersionId:s.projection.baseVersionId,
      nativeRevision:s.projection.nativeRevision,header:s.header,committedEvents:s.committedEvents,adapterMetadata:s.adapterMetadata,instanceId:prepared.run.instanceId}))}));
  return {root,item,originalSource,runs,appendDsh,observedHeaders,prepared,directory,payload,catalog,effective,artifact,file,recover,nativeId};
}

describe('V3 persisted effective native header recovery',()=>{
  it('checkpoints a cold-open preparation tail without committing a continuation',async()=>{
    const f=await fixture(),prefix=f.payload.events as JsonValue[];
    const value={...f.payload,events:[...prefix,{type:'session/end-seed',seq:prefix.length,time:40,data:{inherited:false}}]};
    await writeFile(f.file,v3NativeSessionCodec.encode(value,{relativePath:f.artifact.relativePath,header:f.effective}));
    expect((await f.recover()).state).toBe('recovered');
    expect(f.appendDsh).not.toHaveBeenCalled();
    expect([...f.runs.receipts.values()]).toHaveLength(0);
    expect(JSON.parse(await readFile(join(dirname(f.prepared.nativeSpace!.root),'space.json'),'utf8')).state).toBe('clean');
  });
  it.each([false,true])('recovers a missing-cwd projection in a fresh lifecycle with native tail=%s',async withTail=>{
    const f=await fixture(),before=await readFile(f.file);
    const prefix=f.payload.events as JsonValue[];
    if(withTail){
      const value={...f.payload,events:[...prefix,...contextEvents().slice(prefix.length)]};
      await writeFile(f.file,v3NativeSessionCodec.encode(value,{relativePath:f.artifact.relativePath,header:f.effective}));
    }
    const recovered=await f.recover();expect(recovered.state).toBe('recovered');
    expect(f.observedHeaders.at(-1)).toEqual(f.effective);
    const space=JSON.parse(await readFile(join(dirname(f.prepared.nativeSpace!.root),'space.json'),'utf8'));
    expect(space.state).toBe('clean');
    expect(JSON.stringify(f.item)).toBe(f.originalSource);
    expect(f.appendDsh).toHaveBeenCalledTimes(withTail?1:0);
    if(withTail){
      const input=f.appendDsh.mock.calls[0]![0];
      expect(input.appendedEvents.every((event:any)=>JSON.stringify(event.extensions.nativeHeader)===JSON.stringify(f.effective))).toBe(true);
      const [receipt]=f.runs.receipts.values();expect(receipt).toMatchObject({status:'committed',canonicalVersionId:'tail-version',projectionRevision:contextEvents().length});
      expect((await v3NativeSessionCodec.inspect(f.prepared.nativeSpace!.root))[0]!.events).toEqual(contextEvents());
    }else expect(await readFile(f.file)).toEqual(before);
  });
  it('rejects a registered non-cwd identity change before mutating the projection',async()=>{
    const f=await fixture(),original=await f.directory.readSession(f.nativeId),before=await readFile(f.file);
    const sessions=f.catalog.sessions.map(item=>({...item,payload:{...item.payload as object,header:{...f.effective as object,createdAt:999}} as JsonValue}));
    await f.directory.replaceSessionCatalog({...f.catalog,sessions});
    await expect(f.recover()).rejects.toThrow('differs beyond its prepared working directory');
    expect(await f.directory.readSession(f.nativeId)).toEqual(original);expect(await readFile(f.file)).toEqual(before);expect(f.appendDsh).not.toHaveBeenCalled();
  });
  it('rejects an actual native header that no longer matches the registered cwd',async()=>{
    const f=await fixture(),original=await f.directory.readSession(f.nativeId);
    const forged={...f.payload,header:{...f.effective as object,cwd:f.root}} as JsonValue;
    const description=await v3NativeSessionCodec.describe(forged,f.prepared.nativeSpace!.root),otherPath=join(f.prepared.nativeSpace!.root,description.relativePath);
    await mkdir(dirname(otherPath),{recursive:true});await writeFile(otherPath,v3NativeSessionCodec.encode(forged,description));await unlink(f.file);
    await expect(f.recover()).rejects.toThrow('Recovery prefix/header rewritten');
    expect(await f.directory.readSession(f.nativeId)).toEqual(original);expect(f.appendDsh).not.toHaveBeenCalled();
  });
});
