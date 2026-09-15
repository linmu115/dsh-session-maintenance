import { expect, it } from "vitest";
import { adapter } from "../../adapter-dsh-0-1-5/src/index.js";
import { normalizeV3Append } from "../../adapter-dsh-0-1-5/src/normalize-append.js";
import { catalogDigest, digest, materializeV3, v3NativeSessionId } from "../../adapter-dsh-0-1-5/src/materialize.js";
import { contextEvents, contextHeader } from "../../adapter-dsh-0-1-5/test/context-fixture.js";
import { createFixtureSandbox } from "../../test-support/src/index.js";
import { MemoryStatusEventAdapter, StatusLog } from "@linmu/dsh-session-status-log";
import { JsonProjectionDirectory, PersistentProjectionCache } from "../src/index.js";

it("upgrades same-head retained V3 caches in place and then reuses the repaired title without another history load",async()=>{
  const f=await createFixtureSandbox("v3-title-cache"),at="2026-09-15T00:00:00Z";
  try{
    const logicalId="logical-title",base=contextEvents(false),events=[...base,{type:"session/title",seq:base.length,time:base.length+1,data:{title:"Durable readable title",messageSeqs:[],source:{kind:"user"}}}];
    const normalized=await normalizeV3Append({runId:"old-run",operationId:"title",nativeSessionId:contextHeader.id,nativeRevision:events.length,observedAt:at,payload:{logicalSessionId:logicalId,instanceId:"copy",header:contextHeader,inheritedEventCount:0,events}} as any);
    const item={session:{schemaVersion:1,id:logicalId,authorityScope:"maintenance",originKind:"maintenance-native",headVersionId:"unchanged-head",title:"DSH session session-placeholder",tags:[],archivedAt:null,tombstonedAt:null,createdAt:at,updatedAt:at},events:normalized.events,workspaceId:null};
    let loads=0,revision=1,selectedLoads=0;
    const source={currentRevision:async()=>revision,load:async(run:any)=>{loads++;return {run,workspaces:[],sessions:[item]};},loadSessions:async(run:any)=>{
      if(revision===1)throw Error("No canonical change should request histories");selectedLoads++;return {run,workspaces:[],sessions:[item]};
    },listChanges:async(query:any)=>{
      if(revision===1)throw Error("No canonical revision changed");return {schemaVersion:1,afterRevision:query.afterRevision,throughRevision:2,currentRevision:2,hasMore:false,
        changes:[{schemaVersion:1,revision:2,logicalSessionId:logicalId,kind:"content-updated",changedAt:at}]};
    }} as any;
    const old={...adapter,manifest:{...adapter.manifest,packageVersion:"0.1.1"},materialize:async(input:any,output:any)=>{
      const digests:Record<string,string>={};
      const manifest=await materializeV3(input,{writeWorkspace:(...args)=>output.writeWorkspace(...args),writeSession:async(id,value)=>{
        const legacy={...(value as any),title:item.session.title};delete legacy.titleProjection;
        await output.writeSession(id,legacy);digests[id]=digest(legacy);
      }});
      return {...manifest,sessionDigests:digests,catalogDigest:catalogDigest(digests,[])};
    }};
    let count=0;const statusLog=new StatusLog(new MemoryStatusEventAdapter(),{clock:()=>at,idFactory:kind=>`${kind}-${++count}`});
    const run=(id:string)=>({schemaVersion:1,id,leaseId:`lease-${id}`,branchId:"main",instanceId:"copy",profileId:"web",dshVersion:"0.1.5-rc.2",adapterId:"dsh-0.1.5",state:"preparing",startedAt:at,heartbeatAt:at,checkpointId:null} as any);
    const configuration={branchId:"main"};
    const first=await new PersistentProjectionCache({runtimeRoot:f.root,source,adapter:old,statusLog,clock:()=>at}).apply({run:run("before"),configuration});
    const nativeId=v3NativeSessionId(logicalId as never);
    expect(await new JsonProjectionDirectory(first.cacheRoot).readSession(nativeId)).toMatchObject({title:item.session.title});
    const manager=new PersistentProjectionCache({runtimeRoot:f.root,source,adapter,statusLog,clock:()=>at});
    const upgraded=await manager.apply({run:run("upgrade"),configuration});
    expect(upgraded.cacheRoot).toBe(first.cacheRoot);expect(upgraded.cacheManifest.cacheKey).toBe(first.cacheManifest.cacheKey);
    expect(upgraded.cacheManifest.adapterFingerprint).not.toBe(first.cacheManifest.adapterFingerprint);
    expect(upgraded.receipt).toMatchObject({baseline:true,rewrittenSessions:1,throughRevision:1});
    expect(upgraded.cacheManifest.sessions[0]?.title).toBe("Durable readable title");
    const repaired=await new JsonProjectionDirectory(upgraded.cacheRoot).readSession(nativeId);
    expect(repaired).toMatchObject({title:"Durable readable title",baseVersionId:"unchanged-head",titleProjection:{title:"Durable readable title",eventSeq:base.length,throughSeq:events.length-1}});
    expect((repaired as any).events).toEqual(events);expect(loads).toBe(2);
    const restarted=await manager.apply({run:run("next-restart"),configuration});
    expect(restarted.receipt).toMatchObject({baseline:false,rewrittenSessions:0,unchangedSessions:1});expect(loads).toBe(2);
    expect(restarted.cacheManifest.sessions[0]?.title).toBe("Durable readable title");
    expect(await new JsonProjectionDirectory(restarted.cacheRoot).readSession(nativeId)).toEqual(repaired);
    expect(item.session.title).toBe("DSH session session-placeholder");
    const renamed={type:"session/title",seq:events.length,time:events.length+1,data:{title:"Renamed in next version",messageSeqs:[],source:{kind:"user"}}};
    const nextEvents=await normalizeV3Append({runId:"next-run",operationId:"rename",nativeSessionId:contextHeader.id,nativeRevision:events.length+1,observedAt:at,payload:{logicalSessionId:logicalId,instanceId:"copy",header:contextHeader,inheritedEventCount:0,events:[...events,renamed]}} as any);
    item.events=nextEvents.events;item.session.headVersionId="renamed-head";revision=2;
    const delta=await manager.apply({run:run("delta-rename"),configuration});
    expect(delta.receipt).toMatchObject({baseline:false,changedSessions:1,rewrittenSessions:1});
    expect(delta.cacheManifest.sessions[0]?.title).toBe("Renamed in next version");expect(loads).toBe(2);expect(selectedLoads).toBe(1);
  }finally{await f.cleanup();}
});
