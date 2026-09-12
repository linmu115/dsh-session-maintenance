import {describe,it,expect} from "vitest";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {migrateLegacy} from "../src/legacy-import.js";
import {sessionFormatCatalog,visibleContext} from "../src/official.js";
import {decodeGeneration,inspectV3NativeSpace} from "../src/generation-reader.js";
import {v3NativeSessionCodec} from "../src/native-session-codec.js";
import {recoverV3RuntimeTail} from "../src/runtime-tail-recovery.js";
import {resolveV3Reference} from "../src/references.js";
import {bindV3NativeAppend} from "../src/runtime-bridge.js";
const header={version:2,id:"synthetic-composite",createdAt:1,isSeeded:false,delegationDepth:0,agentPreset:"code"};
const config={provider:"mock",model:"mock"},message={id:"stable-user",role:"user",source:{kind:"plugin",plugin:"tools-code-mode"},content:[{type:"text",text:"stable text"}]};
const call={rootCallId:"root",parentCallId:"root",subCallId:"child",name:"read",arguments:{path:"fixture"}};
const rows=[
 {type:"turn/start",data:{turn:1}},{type:"step/start",data:{turn:1,step:1}},
 {type:"user/message",data:message,surfaceOp:"append"},
 {type:"request/header",data:{reason:"initial",header:{config,system:"prompt",tools:[],adapterDefaults:{}}}},
 {type:"tool/code-dispatch-start",data:call},{type:"tool/code-dispatch",data:{...call,isError:false,content:message.content}},
 {type:"compaction/prune",data:{shadowedRange:{start:2,end:2},shadowedSeqs:[2],shadowedTokenCount:17}},
 {type:"user/message",data:{...message,id:"replacement"},surfaceOp:{op:"replace",start:2,end:2},sourceEventSeqs:[2]},
 {type:"request/header",data:{reason:"change",header:{config,system:"",tools:[],adapterDefaults:{}}}},
 {type:"step/end",data:{turn:1,step:1}},{type:"turn/end",data:{turn:1,reason:{kind:"completed"}}},
].map((e,seq)=>({...e,seq,time:seq+1}));
const artifact={header,events:rows,inheritedEventCount:0} as any;
function official(input:any){const physical={type:"session",...input.header};if(input.header.version<2){delete physical.isSeeded;if(input.header.isSeeded)physical.seedLength=input.inheritedEventCount;}const reader=sessionFormatCatalog.createRestore(physical,{recovery:"strict",validation:"current"});for(const row of input.events)reader.decodeRow(row);return reader.finish()}
const run={id:"synthetic-run",adapterId:"dsh-0.1.5",instanceId:"synthetic-instance",profileId:"web"} as any;
describe("V3 composite migration and cold recovery",()=>{
 it("matches fixed official system/PTC/compaction migration and preserves a fork cut with an archived detail",()=>{
  const migrated=migrateLegacy(artifact);expect(migrated.artifact).toEqual(official(artifact));expect(migrated.ledger.seqMap[3]).toHaveLength(2);
  const end={type:"session/end-seed",seq:rows.length,time:20,data:{inherited:true}};
  const seeded={...artifact,header:{...header,isSeeded:true,parentSession:"stable-parent",cwd:"C:/synthetic-project"},events:[...rows,end],inheritedEventCount:rows.length};
  const expected=official(seeded);expect(migrateLegacy(seeded).artifact).toEqual(expected);
  const detail={type:"dsh-runtime/detail",seq:rows.length,time:19,data:{id:"historical-card",items:[],state:"completed"}};
  const actual=migrateLegacy({...seeded,events:[...rows,detail,{...end,seq:end.seq+1}],inheritedEventCount:rows.length+1});
  expect(actual.artifact.header.parentSession).toBe("stable-parent");expect(actual.artifact.inheritedEventCount).toBe(expected.inheritedEventCount+1);expect(visibleContext(actual.artifact)).toEqual(visibleContext(expected));expect(actual.ledger.informational).toEqual([detail]);
 });
 it("decodes a legacy physical information event before official migration and refuses future/conflicting generations",async()=>{
  const detail={type:"dsh-runtime/detail",seq:rows.length,time:19,data:{id:"card",items:[]}};
  const text=[{type:"session",...header},...rows,detail].map(e=>JSON.stringify(e)+"\n").join("");const decoded=decodeGeneration(Buffer.from(text),"none",2);expect(decoded.artifact.events.at(-1)).toMatchObject({type:detail.type,ignorable:true});
  const root=await mkdtemp(join(tmpdir(),"synthetic-v3-generations-"));try{const payload={...decoded.artifact,projectId:"fixture"};const d=await v3NativeSessionCodec.describe(payload as any,root);const file=join(root,d.relativePath);await mkdir(dirname(file),{recursive:true});await writeFile(file,v3NativeSessionCodec.encode(payload as any,d));await writeFile(join(dirname(file),"session.v4.jsonl"),"future");await expect(inspectV3NativeSpace(root)).rejects.toThrow("Future");await rm(join(dirname(file),"session.v4.jsonl"));await writeFile(join(dirname(file),"session.v3.jsonl"),"duplicate");await expect(inspectV3NativeSpace(root)).rejects.toThrow("Conflicting");}finally{await rm(root,{recursive:true,force:true})}
 });
 it("recovers one deterministic tail and refuses a rewritten committed prefix",async()=>{
  const root=await mkdtemp(join(tmpdir(),"synthetic-v3-recovery-"));try{const original=migrateLegacy(artifact).artifact,detail={type:"dsh-runtime/detail",seq:original.events.length,time:30,data:{id:"after-crash"},ignorable:true};const payload={...original,events:[...original.events,detail],projectId:"fixture"};const d=await v3NativeSessionCodec.describe(payload as any,root),file=join(root,d.relativePath);await mkdir(dirname(file),{recursive:true});await writeFile(file,v3NativeSessionCodec.encode(payload as any,d));const mapping={nativeSessionId:original.header.id,logicalSessionId:"logical",baseVersionId:null,nativeRevision:original.events.length,header:d.header,committedEvents:original.events,instanceId:run.instanceId};const input={runId:run.id,persistenceRoot:root,sessions:[mapping],observedAt:"2026-09-12T00:00:00.000Z"} as any;const first=await recoverV3RuntimeTail(input),second=await recoverV3RuntimeTail({...input,observedAt:"2026-09-12T01:00:00.000Z"});expect(first[0]!.operationId).toBe(second[0]!.operationId);expect((first[0]!.payload as any).events).toEqual([detail]);await expect(recoverV3RuntimeTail({...input,sessions:[{...mapping,committedEvents:original.events.map((e,i)=>i===0?{...e,time:100}:e)}]})).rejects.toThrow("rewritten");}finally{await rm(root,{recursive:true,force:true})}
 });
 it("binds host appends without trusting host scope and resolves a live-created native ID",async()=>{
  const converted=migrateLegacy(artifact).artifact,payload={...converted,logicalSessionId:"logical",instanceId:run.instanceId,profileId:run.profileId};const reader={readSession:async(id:string)=>{if(id!==header.id)throw Object.assign(new Error("missing"),{code:"ENOENT"});return payload},listNativeSessionIds:async()=>[header.id]};const reference={logicalSessionId:"logical",logicalAnchorId:"stable-user",legacyNativeSessionId:header.id} as any;
  expect(await resolveV3Reference(reference,run,reader as any)).toMatchObject({status:"resolved",nativeSessionId:header.id,nativeAnchorId:"stable-user"});expect(await resolveV3Reference(reference,{...run,instanceId:"other"},reader as any)).toMatchObject({status:"unavailable"});
  const operation={runId:run.id,nativeSessionId:header.id,payload:{logicalSessionId:"logical",events:[]}} as any;expect((await bindV3NativeAppend(operation,run,reader as any)).payload).toMatchObject({instanceId:run.instanceId,header:converted.header,inheritedEventCount:0});await expect(bindV3NativeAppend({...operation,payload:{...operation.payload,instanceId:"other"}},run,reader as any)).rejects.toThrow("instance mismatch");
 });
});

it("preserves the official refusal for released V0 surface history before the first step",async()=>{
 const bytes=await readFile(new URL("./fixtures/released-v0-real-shapes.jsonl",import.meta.url));const [physical,...events]=bytes.toString("utf8").trim().split("\n").map(line=>JSON.parse(line));const reader=sessionFormatCatalog.createRestore(physical,{recovery:"strict",validation:"current"});expect(()=>{for(const event of events)reader.decodeRow(event);reader.finish()}).toThrow(/surface before first step/);expect(()=>decodeGeneration(bytes,"none",0)).toThrow(/surface before first step/);
});
it("preserves text stream completion and per-source provenance through v1 coalescing",()=>{
 const rows=[{type:"turn/start",data:{turn:1}},{type:"step/start",data:{turn:1,step:1}},
  {type:"assistant/chunk",data:{turn:1,step:1,chunk:{type:"text-delta",index:0,text:"hello"}}},
  {type:"assistant/chunk",data:{turn:1,step:1,chunk:{type:"finish",reason:{kind:"stop"}}}},
  {type:"assistant/message",data:{turn:1,step:1,message:{id:"stable-assistant",role:"assistant",source:{kind:"model",provider:"mock",model:"mock"},content:[{type:"text",text:"hello"}]}},sourceEventSeqs:[2,3],surfaceOp:"append"},
  {type:"step/end",data:{turn:1,step:1}},{type:"turn/end",data:{turn:1,reason:{kind:"completed"}}}].map((e,seq)=>({...e,seq,time:seq+1}));
 const source={header:{version:1,id:"synthetic-stream",createdAt:1,delegationDepth:0,isSeeded:false},events:rows,inheritedEventCount:0};
 const migrated=migrateLegacy(source as any);expect(migrated.artifact).toEqual(official(source));expect(migrated.ledger.seqMap).toHaveLength(rows.length);expect(migrated.artifact.events.find(e=>e.type==="assistant/message")?.data).toMatchObject({message:{id:"stable-assistant",content:[{type:"text",text:"hello"}]}});
});
