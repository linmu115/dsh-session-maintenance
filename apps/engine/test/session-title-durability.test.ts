import { expect, it, vi } from "vitest";
import { REQUIRED_CAPABILITIES } from "@linmu/dsh-session-adapter-0-1-5";
import { contextEvents, contextHeader } from "../../../packages/adapter-dsh-0-1-5/test/context-fixture.js";
import { createEngineFixture, hashTree, joinInstanceWorkspace } from "./helpers.js";

it("commits native titles and preserves the renamed title through later ordinary append batches",async()=>{
  const f=await createEngineFixture("native-title-durable"),untouched=await Promise.all([hashTree(f.codexHome),hashTree(f.dshHome)]);
  try{
    const at="2026-09-15T00:00:00Z",clientId="title-runtime",header={...contextHeader,cwd:f.root};
    await joinInstanceWorkspace(f.engine,{instanceId:"title-copy",cwd:f.root});
    const run=await f.engine.prepareProjectionRuntimeRun({schemaVersion:1,client:{kind:"launcher",id:"title-launcher"},runtimeClientId:clientId,
      instanceId:"title-copy",profileId:"web",dshVersion:"0.1.5-rc.2",maintenanceEndpoint:"http://127.0.0.1:41781",branchId:"main",pinnedAdapterId:"dsh-0.1.5",projectSelection:{kind:"all"},
      environment:{runtimeCapabilities:[...REQUIRED_CAPABILITIES],packageVersions:Object.fromEntries(["@deepseek-ai/dsh-session","@deepseek-ai/dsh-session-persistence","@deepseek-ai/dsh-session-format-catalog"].map(name=>[name,"0.1.5-rc.2"]))}} as any);
    await f.engine.attachProjectionRuntimeRun({schemaVersion:1,clientId,runId:run.runId,temporaryPersistenceRootId:run.temporaryPersistenceRootId,attachedAt:at,nativeMode:run.nativeMode});
    const registration=await f.engine.registerProjectionRuntimeSession({schemaVersion:1,clientId,runId:run.runId,nativeSessionId:contextHeader.id as never,header,title:"DSH session session-placeholder"});
    const read=()=>f.engine.canonicalEngine.store.getSession(registration.logicalSessionId);
    expect((await read())!.session.title).toBe("DSH session session-placeholder");
    const base=contextEvents(false),first=[...base,{type:"session/title",seq:base.length,time:base.length+1,data:{title:"First title",messageSeqs:[],source:{kind:"user"}}}];
    const append=async(events:any[],operationId:string)=>{
      const result=await f.engine.appendProjectionRuntimeEvent(clientId,{runId:run.runId,nativeSessionId:contextHeader.id as never,operationId:operationId as never,nativeRevision:events.at(-1).seq+1,observedAt:at,
        payload:{logicalSessionId:registration.logicalSessionId,instanceId:"title-copy",header,inheritedEventCount:0,events}});
      expect(result.status).toBe("committed");return result;
    };
    await append(first,"first-title");expect((await read())!.session.title).toBe("First title");
    const second={type:"session/title",seq:first.length,time:first.length+1,data:{title:"Renamed title",messageSeqs:[],source:{kind:"user"}}};
    const upsert=vi.spyOn(f.engine.projectionRunRepository,"upsertProjectionSession").mockRejectedValueOnce(new Error("injected mapping persistence failure"));
    await expect(append([second],"renamed-title")).rejects.toMatchObject({code:"PROJECTION_RECEIPT_WRITE_FAILED"});
    expect((await read())!.session.title).toBe("Renamed title");
    const committed=await f.engine.projectionRunRepository.getOperationReceipt("renamed-title" as never);
    expect(committed?.status).toBe("committed");
    await append([second],"renamed-title");upsert.mockRestore();const version=(await read())!.session.headVersionId;
    expect((await read())!.session.title).toBe("Renamed title");
    await append([{type:"turn/start",seq:first.length+1,time:first.length+2,data:{turn:2}}],"ordinary-tail");
    expect((await read())!.session.title).toBe("Renamed title");expect((await read())!.session.headVersionId).not.toBe(version);
    const latest={type:"session/title",seq:first.length+2,time:first.length+3,data:{title:"Latest title",messageSeqs:[],source:{kind:"user"}}};
    await append([latest],"latest-title");await append([second],"renamed-title");
    await append([{type:"step/start",seq:first.length+3,time:first.length+4,data:{turn:2,step:1}}],"after-old-retry");
    expect((await read())!.session.title).toBe("Latest title");
  }finally{expect(await Promise.all([hashTree(f.codexHome),hashTree(f.dshHome)])).toEqual(untouched);await f.cleanupAll();}
},15000);
