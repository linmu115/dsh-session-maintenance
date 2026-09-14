import { describe, expect, it } from 'vitest';
import { createEngineFixture, hashTree } from './helpers.js';
import { REQUIRED_CAPABILITIES, v3NativeSessionCodec } from '@linmu/dsh-session-adapter-0-1-5';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { JsonProjectionDirectory, projectionRootFor } from '@linmu/dsh-session-projection-lifecycle';
import { contextHeader, contextEvents } from '../../../packages/adapter-dsh-0-1-5/test/context-fixture.js';
import type { RuntimeBrokerPrepareRunRequest } from '@linmu/dsh-session-contracts';

const at='2026-09-13T00:00:00Z';
describe('RC2 upstream through real Engine and authenticated HTTP',()=>{
  it('captures a completed boundary, binds/revokes idempotently and never reads a later source version',async()=>{
    const f=await createEngineFixture('upstream-context-rc2');
    try {
      const before=await Promise.all([hashTree(f.codexHome),hashTree(f.dshHome)]);
      const request:RuntimeBrokerPrepareRunRequest={schemaVersion:1,client:{kind:'launcher',id:'fixture-launcher'},runtimeClientId:'fixture-runtime',
        instanceId:'fixture-rc2-copy',profileId:'web',dshVersion:'0.1.5-rc.2',maintenanceEndpoint:'http://127.0.0.1:41781',branchId:'main' as never,
        pinnedAdapterId:'dsh-0.1.5' as never,projectSelection:{kind:'all'},environment:{runtimeCapabilities:[...REQUIRED_CAPABILITIES],
          packageVersions:Object.fromEntries(['@deepseek-ai/dsh-session','@deepseek-ai/dsh-session-persistence','@deepseek-ai/dsh-session-format-catalog'].map(p=>[p,'0.1.5-rc.2']))}};
      const run=await f.engine.prepareProjectionRuntimeRun(request);
      const sourceHeader={...contextHeader,cwd:f.root};
      await f.engine.attachProjectionRuntimeRun({schemaVersion:1,clientId:request.runtimeClientId,runId:run.runId,
        temporaryPersistenceRootId:run.temporaryPersistenceRootId,attachedAt:at,nativeMode:run.nativeMode});
      const mappings:Record<string,any>={};
      for(const id of ['source-native','target-native'])mappings[id]=await f.engine.registerProjectionRuntimeSession({schemaVersion:1,
        clientId:request.runtimeClientId,runId:run.runId,nativeSessionId:id as never,header:{...sourceHeader,id},title:id});
      const append=async(events:any[],operationId:string)=>f.engine.appendProjectionRuntimeEvent(request.runtimeClientId,{
        runId:run.runId,nativeSessionId:'source-native' as never,operationId:operationId as never,nativeRevision:events.at(-1).seq+1,observedAt:at,
        payload:{logicalSessionId:mappings['source-native'].logicalSessionId,instanceId:request.instanceId,header:sourceHeader,inheritedEventCount:0,events}});
      const original=contextEvents(false);
      original.splice(4,0,{type:'dsh-runtime/detail',ignorable:true,data:{id:'fixture-detail',items:[],state:'completed'}});
      const prefix=original.map((event,seq)=>({...event,seq,time:seq+1}));
      expect((await append(prefix,'append-first')).status).toBe('committed');
      const scope={instanceId:request.instanceId,profileId:'web',namespace:'annotation-upstream'};
      const server=await f.startServer();
      const post=async(operation:string,input:object,auth=true)=>{
        const res=await fetch(server.origin+'/v1/session-context/'+operation,{method:'POST',headers:{'content-type':'application/json',
          ...(auth?{authorization:`Bearer ${server.token}`}:{})},body:JSON.stringify({runId:run.runId,...input})});
        return {status:res.status,value:await res.json() as any};
      };
      expect((await post('directory',{},false)).status).toBe(401);
      expect(JSON.stringify((await post('directory',{})).value)).toContain('尚未配置');
      const connect=(pluginVersion:string)=>f.engine.extensions!.connect({instanceId:scope.instanceId,profileId:scope.profileId,
        plugins:[{namespace:scope.namespace,pluginVersion,writerId:'dsh-annotation-core'}]});
      connect('0.3.12-rc2.999');
      const incompatible=await post('directory',{});
      expect(incompatible.status).toBe(409);expect(JSON.stringify(incompatible.value)).toContain('版本不兼容');
      expect(JSON.stringify(incompatible.value)).toContain('0.3.12-rc2.999');
      for(const version of ['0.3.12-rc2.1','0.3.12-rc2.2','0.3.12-rc2.3','0.3.12-rc2.4','0.3.12-rc2.5','0.3.12-rc2.6']){
        connect(version);
        expect((await post('directory',{})).status,version).toBe(200);
      }
      f.engine.extensions!.enable(scope,false);
      expect(JSON.stringify((await post('directory',{})).value)).toContain('已停用');
      f.engine.extensions!.enable(scope,true);
      const workspaces=await post('directory',{});expect(workspaces.status).toBe(200);
      expect(workspaces.value.items[0].title).not.toBe('未分组');
      const directory=await post('directory',{workspaceId:workspaces.value.items[0].id});
      expect(directory.value.items.map((x:any)=>x.id)).toContain('target-native');
      expect(JSON.stringify(directory.value)).not.toContain('old question');
      const input={targetNativeSessionId:'target-native',sourceNativeSessionId:'source-native',operationId:'selection-one',anchorId:'reply-one',selectedText:'selected passage'};
      const captured=await post('capture',input);expect(captured.status,JSON.stringify(captured.value)).toBe(200);
      expect((await post('capture',input)).value).toEqual(captured.value);
      expect((await append(contextEvents().slice(7).map(event=>({...event,seq:event.seq+1})),'append-second')).status).toBe('committed');
      // A retry may reuse the exact prior capture; a new operation may not
      // silently replace a graph material's selected immutable version.
      expect((await post('capture',{...input,expectedSourceVersionId:captured.value.sourceVersionId})).value).toEqual(captured.value);
      const beforeRejectedCapture=f.engine.extensions!.list(scope).items.length;
      const stale=await post('capture',{...input,operationId:'new-graph-selection',expectedSourceVersionId:captured.value.sourceVersionId});
      expect(stale.status).toBe(409);expect(JSON.stringify(stale.value)).toContain('来源版本已改变');
      const changedRetry=await post('capture',{...input,expectedSourceVersionId:'another-version'});
      expect(changedRetry.status).toBe(409);expect(JSON.stringify(changedRetry.value)).toContain('所选材料');
      expect(f.engine.extensions!.list(scope).items.length).toBe(beforeRejectedCapture);
      const ref={targetNativeSessionId:'target-native',referenceId:captured.value.referenceId};
      const page=await post('read',{...ref,executionId:'turn-one'});
      expect(page.status,JSON.stringify(page.value)).toBe(200);
      expect(JSON.stringify(page.value)).toContain('AFTER-SELECTION');expect(JSON.stringify(page.value)).not.toContain('FUTURE');
      expect(page.value.sourceVersionId).toBe(captured.value.sourceVersionId);
      const initial=await post('read',{...ref,executionId:'initial-submission',view:'selected-turn'});
      expect(initial.status,JSON.stringify(initial.value)).toBe(200);
      expect(initial.value.items.map((item:any)=>item.role)).toEqual(['user','assistant']);
      expect(initial.value.items[0].text).toBe('old question');
      expect(initial.value.items[1].text).toContain('AFTER-SELECTION');
      expect(initial.value).toMatchObject({sourceVersionId:captured.value.sourceVersionId,selectedTurn:{complete:true},hasMore:false});
      expect(JSON.stringify(initial.value)).not.toContain('FUTURE');
      expect((await post('read',{...ref,executionId:'invalid-initial',view:'selected-turn',query:'anything'})).status).toBe(409);
      const search=await post('read',{...ref,executionId:'turn-one',query:'FUTURE'});
      expect(search.value.items).toEqual([]);
      expect((await post('end-execution',{targetNativeSessionId:'target-native',executionId:'turn-one'},false)).status).toBe(401);
      expect((await post('end-execution',{targetNativeSessionId:'target-native',executionId:'turn-one'})).value).toEqual({ended:true});
      expect((await post('end-execution',{targetNativeSessionId:'target-native',executionId:'turn-one'})).status).toBe(200);
      const replay=await post('read',{...ref,executionId:'turn-one'});
      expect(replay.status).toBe(409);expect(JSON.stringify(replay.value)).toContain('不能重放');
      expect((await post('read',{...ref,executionId:'turn-two'})).status).toBe(200);
      expect((await post('read',{...ref,targetNativeSessionId:'source-native',executionId:'foreign'})).status).toBe(409);
      expect((await post('bind',{...ref,targetMessageId:'target-user'})).value.state).toBe('sent');
      const revision=f.engine.extensions!.get(scope,ref.referenceId).object.revision;
      await post('bind',{...ref,targetMessageId:'target-user'});
      expect(f.engine.extensions!.get(scope,ref.referenceId).object.revision).toBe(revision);
      expect((await post('bind',{...ref,targetMessageId:null})).value.state).toBe('revoked');
      expect((await post('bind',{...ref,targetMessageId:null})).status).toBe(200);
      expect((await post('read',{...ref,executionId:'next-turn'})).status).toBe(409);
      expect((await post('read',{...ref,executionId:'next-initial',view:'selected-turn'})).status).toBe(409);
      expect(f.engine.extensions!.list(scope).items).toHaveLength(1);
      expect(f.engine.repository.database.prepare('SELECT count(*) n FROM context_read_executions WHERE run_id=?').get(run.runId)!.n).toBeGreaterThan(0);
      // This fixture registers through the bridge without an actual DSH writer;
      // provide its synthetic native files before exercising normal close.
      const projection=new JsonProjectionDirectory(projectionRootFor(f.engine.projectionRuntimeRoot,run.runId));
      for(const id of ['source-native','target-native']){
        const payload=await projection.readSession(id as never),description=await v3NativeSessionCodec.describe(payload,run.persistenceRoot);
        const path=join(run.persistenceRoot,description.relativePath);await mkdir(dirname(path),{recursive:true});
        await writeFile(path,v3NativeSessionCodec.encode(payload,description));
      }
      await f.engine.drainProjectionRuntimeRun({schemaVersion:1,clientId:request.runtimeClientId,runId:run.runId,runtimeFlushCompletedAt:at});
      await f.engine.closeProjectionRuntimeRun({schemaVersion:1,clientId:request.client.id,runId:run.runId,reason:'normal'});
      expect(f.engine.repository.database.prepare('SELECT count(*) n FROM context_read_executions WHERE run_id=?').get(run.runId)!.n).toBe(0);
      expect((await post('read',{...ref,executionId:'turn-one'})).status).toBe(409);
      expect(await Promise.all([hashTree(f.codexHome),hashTree(f.dshHome)])).toEqual(before);
    } finally {await f.cleanupAll();}
  },60000);
});
