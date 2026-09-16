import { describe, expect, it } from "vitest";
import { contextEvents, contextHeader } from "./context-fixture.js";
import { normalizeV3Append } from "../src/normalize-append.js";
import { materializeV3, v3ProjectedNativeRevision } from "../src/materialize.js";
import { v3TitleProjection } from "../src/session-title.js";
import { visibleContext } from "../src/official.js";
import { CANONICAL_CONVERSATION_TOPOLOGY_EXTENSION as TOPOLOGY } from "@linmu/dsh-session-contracts";
import { restorePortableCanonical } from "../src/portable-v3.js";
import { v3NativeSessionCodec } from "../src/native-session-codec.js";
import { decodeGeneration } from "../src/generation-reader.js";
import { Session, SessionId, SessionLogOffset } from "@deepseek-ai/dsh-session";

const at="2026-09-15T00:00:00Z";
const title=(seq:number,text:string,extra:object={})=>({type:"session/title",seq,time:seq+1,data:{title:text,messageSeqs:[],source:{kind:"user"},...extra}});
const operation=(events:any[])=>({runId:"title-run",operationId:"title-op",nativeSessionId:contextHeader.id,nativeRevision:events.at(-1)?.seq+1||0,observedAt:at,
  payload:{instanceId:"title-instance",logicalSessionId:"logical-title",header:contextHeader,inheritedEventCount:0,events}} as any);
async function projection(events:any[],name="DSH session session-placeholder"){
  const normalized=await normalizeV3Append(operation(events));let payload:any;
  const item={session:{id:"logical-title",headVersionId:"fixed-head",createdAt:at,updatedAt:at,title:name,tags:[]},events:normalized.events,workspaceId:null};
  await materializeV3({run:{id:"run",instanceId:"instance",profileId:"web"},sessions:[item],workspaces:[]} as any,{writeWorkspace:async()=>{},writeSession:async(_id,value)=>{payload=value;}});
  return {normalized,item,payload};
}

describe("durable RC2 session titles",()=>{
  it("recovers the last native rename over old registration metadata without changing messages or event identity",async()=>{
    const base=contextEvents(false),events=[...base,title(base.length,"Initial readable title"),title(base.length+1,"Renamed readable title")];
    const first=await projection(events);
    expect(first.normalized.metadata).toMatchObject({sessionTitle:"Renamed readable title"});
    expect(first.payload).toMatchObject({title:"Renamed readable title",titleProjection:{title:"Renamed readable title",eventSeq:base.length+1,throughSeq:events.length-1}});
    expect(first.payload.events).toEqual(events);
    expect(visibleContext({...first.payload,header:{...first.payload.header,id:contextHeader.id}})).toEqual(visibleContext({header:contextHeader,events:base,inheritedEventCount:0} as any));
    expect(v3ProjectedNativeRevision(first.item as any,first.payload)).toBe(events.length);
    const next=await projection(first.payload.events);
    expect(next.payload.titleProjection).toEqual(first.payload.titleProjection);
    expect(next.payload.events).toEqual(events);
  });
  it("returns title metadata only for a valid title in this append tail",async()=>{
    const renamed=await normalizeV3Append(operation([title(9,"User rename")]));
    expect(renamed.metadata).toMatchObject({sessionTitle:"User rename",nativeRevision:10});
    const normal=await normalizeV3Append(operation([{type:"turn/start",seq:10,time:11,data:{turn:2}}]));
    expect(normal.metadata).not.toHaveProperty("sessionTitle");
  });
  it("does not promote invalid informational payloads or foreign event names into title authority",()=>{
    const valid=title(3,"Valid title");
    for(const invalid of [title(4,"   "),title(4,"Untrusted",{messageSeqs:[4]}),title(4,"Untrusted",{messageSeqs:[2,1]}),title(4,"Untrusted",{messageSeqs:[1,1],source:{kind:"provider",provider:"titles"}}),title(4,"Untrusted",{source:{kind:"unknown"}}),{...title(4,"Untrusted"),type:"plugin/title"}]){
      expect(v3TitleProjection([valid,invalid] as any,4)).toEqual({title:"Valid title",eventSeq:3,throughSeq:4});
    }
    expect(()=>v3TitleProjection([title(5,"Future")] as any,4)).toThrow(/outside/);
    expect(v3TitleProjection([], -1)).toEqual({title:null,eventSeq:null,throughSeq:-1});
    expect(v3TitleProjection([title(4,"Provider title",{messageSeqs:[2,1],source:{kind:"provider",provider:"titles"}})] as any,4).title).toBe("Provider title");
  });
  it("keeps the canonical mirror title when its restored prefix has no native title event",async()=>{
    let payload:any;
    await materializeV3({run:{id:"run",instanceId:"instance",profileId:"web"},workspaces:[],sessions:[{
      session:{id:"mirror",originKind:"codex-mirror",headVersionId:"mirror-v1",createdAt:at,updatedAt:at,title:"Codex mirror title",tags:[]},events:[],workspaceId:null,
    }]} as any,{writeWorkspace:async()=>{},writeSession:async(_id,value)=>{payload=value;}});
    expect(payload.title).toBe("Codex mirror title");
    expect(payload.titleProjection).toEqual({title:"Codex mirror title",eventSeq:0,throughSeq:0});
  });
});

const portableSource=()=>[{
  schemaVersion:1,id:"source-message",logicalSessionId:"mirror",sequence:0,kind:"user-message",role:"user",
  content:{text:"Original prompt"},contentDigest:"fixture-digest",rawPayload:{original:true},
  source:{platform:"codex",instanceId:"fixture",sessionId:"source",eventId:"original-message",cursor:"1"},
  extensions:{[TOPOLOGY]:{schemaVersion:1,turnId:"turn-0",turnOrdinal:0,stepId:null,stepOrdinal:null,phase:"user",inference:"derived"}},
}];
async function mirrorProjection(events:any[],name="机试DeepLearning",derived=false){
  let payload:any;
  const item={session:{id:"mirror",originKind:derived?"codex-derived":"codex-mirror",headVersionId:"fixed",createdAt:at,updatedAt:at,title:name,tags:[]},events,workspaceId:null};
  await materializeV3({run:{id:"run",instanceId:"fixture",profileId:"web"},sessions:[item],workspaces:[]} as any,
    {writeWorkspace:async()=>{},writeSession:async(_id,value)=>{payload=value;}});
  return {item,payload};
}
function coldTitle(payload:any){
  const description={header:payload.header,relativePath:"synthetic"};
  const bytes=v3NativeSessionCodec.encode(payload,description);
  v3NativeSessionCodec.verifyEncoded!(bytes,payload,description);
  const {artifact,complete}=decodeGeneration(Buffer.from(bytes),"zstd",3);
  expect(complete).toBe(true);
  const session=Session.fromRestore(SessionId(artifact.header.id),structuredClone(artifact.events) as never,artifact.header as never,SessionLogOffset(0),"detached");
  // DSH's title projection starts at null and folds session/title only. No
  // Maintenance catalog or seeded cache participates in this cold read.
  return session.snapshotEvents().reduce<string|null>((value,event)=>event.type==="session/title"?(event.data as any).title:value,null);
}
describe("Codex mirror titles in cold native history",()=>{
  it("survives cache-free reopen and Codex rename without changing source rows or message anchors",async()=>{
    const source=portableSource();
    const first=await mirrorProjection(source);
    expect(coldTitle(first.payload)).toBe("机试DeepLearning");
    expect(coldTitle(first.payload)).toBe("机试DeepLearning");
    expect(restorePortableCanonical(first.payload)).toEqual(source);
    const renamed=await mirrorProjection(source,"Renamed in Codex");
    expect(coldTitle(renamed.payload)).toBe("Renamed in Codex");
    expect(renamed.payload.anchorAliases).toEqual(first.payload.anchorAliases);
    expect(renamed.payload.events.slice(0,-1)).toEqual(first.payload.events.slice(0,-1));
    expect(v3ProjectedNativeRevision(first.item as any,first.payload)).toBe(first.payload.events.length);
  });
  it.each([false,true])("preserves the native tail and later DSH rename after derivation (empty=%s)",async empty=>{
    const source=empty?[]:portableSource();
    const base=await mirrorProjection(source);
    const renamed=title(base.payload.events.length,"DSH user rename");
    const append=operation([renamed]);
    const normalized=await normalizeV3Append({...append,nativeSessionId:base.payload.header.id,payload:{...append.payload,header:base.payload.header}});
    const derived=await mirrorProjection([...source,...normalized.events],"DSH user rename",true);
    expect(derived.payload.events.at(-1)).toEqual(renamed);
    expect(coldTitle(derived.payload)).toBe("DSH user rename");
    expect(v3ProjectedNativeRevision(derived.item as any,derived.payload)).toBe(derived.payload.events.length);
  });
  it("does not shift a pre-upgrade derived native tail",async()=>{
    const source=portableSource();
    const base=await mirrorProjection(source);
    const oldLength=base.payload.events.length-1;
    const renamed=title(oldLength,"Existing DSH title");
    const append=operation([renamed]);
    const normalized=await normalizeV3Append({...append,nativeSessionId:base.payload.header.id,payload:{...append.payload,header:base.payload.header}});
    const derived=await mirrorProjection([...source,...normalized.events],"Existing DSH title",true);
    expect(derived.payload.events).toEqual([...base.payload.events.slice(0,-1),renamed]);
    expect(coldTitle(derived.payload)).toBe("Existing DSH title");
  });
});
