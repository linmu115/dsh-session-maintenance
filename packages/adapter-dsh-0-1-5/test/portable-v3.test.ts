import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANONICAL_CONVERSATION_TOPOLOGY_EXTENSION as TOPOLOGY } from "@linmu/dsh-session-contracts";
import { materializePortableV3, restorePortableCanonical } from "../src/portable-v3.js";
import { preparePortableResources, validatePortableAttachments, portableResourceManifest, verifyPortableResources } from "../src/portable-resources.js";
import { materializeV3 } from "../src/materialize.js";
import { visibleContext } from "../src/official.js";
import { v3NativeSessionCodec } from "../src/native-session-codec.js";
import { normalizeV3Append } from "../src/normalize-append.js";
import { restoreV3Metadata } from "../src/native-metadata.js";
import { assertInformational } from "../src/references-remap.js";
const header={version:3,id:"portable-fixture",createdAt:1,delegationDepth:0,isSeeded:false};
const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
function row(kind:string,sequence:number,content:unknown,step=0):any {return {schemaVersion:1,id:`original-${sequence}`,logicalSessionId:"synthetic",sequence,kind,role:kind==="user-message"?"user":"assistant",content,contentDigest:`original-digest-${sequence}`,source:{platform:"codex",instanceId:"codex-test",sessionId:"source-test",eventId:`source-${sequence}`,cursor:String(sequence)},rawPayload:{original:true},extensions:{[TOPOLOGY]:{schemaVersion:1,turnId:"turn-0",turnOrdinal:0,stepId:kind==="user-message"?null:`step-${step}`,stepOrdinal:kind==="user-message"?null:step,phase:kind==="user-message"?"user":kind==="assistant-message"?"assistant":kind,inference:"derived"}}};}
function fixture(){return [row("user-message",0,{text:"input",attachments:[{name:"pixel.png",source:`data:image/png;base64,${png}`}]}),row("reasoning",1,{text:"reason",attachments:[]}),row("tool-call",2,{callId:"exact-call",name:"example",arguments:'{"b": 1,"A":2}',protocol:"synthetic"}),row("other",3,{schemaVersion:1,type:"other",reason:"unsupported-source-event",sourceKind:"codex/example",label:"retained",summary:"record between call and result",evidenceRef:null}),row("tool-result",4,{callId:"exact-call",name:"example",outputText:"unchanged\r\nresult",protocol:"synthetic"}),row("assistant-message",5,{id:"exact-assistant",text:"final",attachments:[]},1)];}
describe("dedicated canonical V3 projection",()=>{
 it('preserves inherited portable receipts through fork append and evidence restoration',async()=>{
  const source=fixture().map(e=>e.kind==='other'?{...e,role:'unknown',rawPayload:null,extensions:{}}:e);
  const artifact=materializePortableV3(header,source).artifact;
  const stored=new Map<string,any>();
  const evidence={putEvidence:async(value:any)=>{const ref=`receipt-${stored.size}`;stored.set(ref,value);return{ref};},readEvidence:async(ref:string)=>stored.get(ref)};
  const result=await normalizeV3Append({runId:'run',operationId:'fork-append',nativeSessionId:header.id,nativeRevision:artifact.events.length,observedAt:new Date().toISOString(),
    payload:{logicalSessionId:'synthetic',instanceId:'fixture',header:artifact.header,inheritedEventCount:0,events:artifact.events}} as any,evidence as any);
  const restored=await restoreV3Metadata(result.events,evidence as any);
  expect(restored.map(e=>e.rawPayload)).toEqual(artifact.events);
  expect(result.events.filter(e=>e.kind==='other')).toHaveLength(fixture().length);
  const receipt=artifact.events.find(e=>e.type==='maintenance/canonical-event')!;
  expect(()=>assertInformational({...receipt,surfaceOp:'append'})).toThrow(/inert/);
  expect(()=>assertInformational({...receipt,ignorable:false})).toThrow(/inert/);
  expect(()=>assertInformational({...receipt,data:{...receipt.data as any,converter:'unknown'}})).toThrow(/converter/);
  expect(()=>assertInformational({...receipt,data:{...receipt.data as any,canonicalContent:'changed'}})).toThrow(/mismatch/);
 });
 it('verifies retained resource identities without session bodies and distinguishes missing from corrupt assets',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-portable-manifest-fixture-'));
  try{
   const sessions=join(root,'native-spaces','a'.repeat(64),'sessions');await mkdir(sessions,{recursive:true});
   const material=materializePortableV3(header,[row('user-message',0,{text:'private session text',attachments:[{name:'pixel.png',source:`data:image/png;base64,${png}`},{name:'data.bin',source:'data:application/octet-stream;base64,AAECAw=='}]})]);
   const payload={...material.artifact,portableAttachments:material.attachments} as any;
   const manifest=portableResourceManifest(payload);expect(JSON.stringify(manifest)).not.toContain(png);expect(JSON.stringify(manifest)).not.toContain('private session text');
   expect(v3NativeSessionCodec.resourceManifest).toBe(portableResourceManifest);expect(v3NativeSessionCodec.verifyResources).toBe(verifyPortableResources);
   expect(await verifyPortableResources(manifest,sessions)).toBe(false);
   await preparePortableResources(payload,sessions);expect(await verifyPortableResources(manifest,sessions)).toBe(true);
   const item=material.attachments[1]!,digest=String(item.ref.attachmentId).slice(7),file=join(sessions,'..','attachments','v1','files',digest.slice(0,2),digest,'data.bin');
   await rm(file);expect(await verifyPortableResources(manifest,sessions)).toBe(false);
   await preparePortableResources(payload,sessions);expect(await verifyPortableResources(manifest,sessions)).toBe(true);
   await writeFile(file,'corrupt');await expect(verifyPortableResources(manifest,sessions)).rejects.toThrow(/differs/);
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it("keeps ordered image/file content and archives log-only reasoning without model exposure",()=>{
  const source=[row("user-message",0,{text:"body",attachments:[{name:"one.png",source:`data:image/png;base64,${png}`},{name:"two.bin",source:"data:application/octet-stream;base64,AAECAw=="},{name:"three.png",source:`data:image/png;base64,${png}`}]}),row("reasoning",1,{text:"private reasoning sentinel"}),row("assistant-message",2,{text:"visible answer"})];
  const result=materializePortableV3(header,source),context=visibleContext(result.artifact) as any[];
  expect(context[0].content.map((b:any)=>b.type)).toEqual(["text","image","file","image"]);
  expect(JSON.stringify(context)).not.toContain("private reasoning sentinel");
  expect(restorePortableCanonical(result.artifact)).toEqual(source);
  expect(result.attachments.map(a=>a.kind)).toEqual(["image","file"]);
  expect(Buffer.from(result.attachments[1]!.base64,"base64")).toEqual(Buffer.from([0,1,2,3]));
 });
 it("preserves every original event, order, tool pairing, message aliases and attachment bytes",()=>{const source=fixture(),result=materializePortableV3(header,source);expect(restorePortableCanonical(result.artifact)).toEqual(source);expect(result.ledger.canonicalMapping.map(m=>m.canonicalSequence)).toEqual([0,1,2,3,4,5]);expect(result.ledger.seqMap.every((row,i)=>i===0||row[0]!>result.ledger.seqMap[i-1]![0]!)).toBe(true);expect(result.anchorAliases["source-5"]).toBe("exact-assistant");expect(result.artifact.events.filter(e=>e.type==="tool/call").map(e=>(e.data as any).callId)).toEqual(["exact-call"]);const card=result.artifact.events.find(e=>e.type==="maintenance/other")!;expect(card.seq).toBeGreaterThan(result.artifact.events.find(e=>e.type==="tool/call")!.seq);expect(card.seq).toBeLessThan(result.artifact.events.find(e=>e.type==="tool/result")!.seq);expect(result.attachments[0]!.base64).toBe(png);expect((result.attachments[0]!.ref)).toMatchObject({width:1,height:1,mediaType:"image/png"});expect(JSON.stringify(visibleContext(result.artifact))).not.toContain("record between call and result");expect(JSON.stringify(visibleContext(result.artifact))).not.toContain("reason");});
 it("splits nonadjacent assistant fragments into distinct native steps so the UI cannot overwrite",()=>{const source=[row("user-message",0,{text:"prompt"}),row("assistant-message",1,{id:"first",text:"first"}),row("other",2,{type:"other",summary:"middle"}),row("assistant-message",3,{id:"second",text:"second"})];const r=materializePortableV3(header,source);const messages=r.artifact.events.filter(e=>e.type==="assistant/message");expect(messages.map(e=>(e.data as any).message.id)).toEqual(["first","second"]);expect(new Set(messages.map(e=>(e.data as any).step)).size).toBe(2);expect(restorePortableCanonical(r.artifact)).toEqual(source);});
 it("refuses lost/duplicate tool identity and ambiguous ordering rather than fabricating repairs",()=>{expect(()=>materializePortableV3(header,[row("tool-result",0,{callId:"missing",outputText:"keep"})])).toThrow(/matching/);expect(()=>materializePortableV3(header,[row("user-message",2,{text:"later"}),row("assistant-message",1,{text:"earlier"})])).toThrow(/increase/);expect(()=>materializePortableV3(header,[row("user-message",0,{content:[],attachments:[{source:`data:image/png;base64,${png}`} ]})])).toThrow(/Ambiguous/);});
 it("persists immutable assets under the same owned root and verifies corrupt pre-existing objects",async()=>{const root=await mkdtemp(join(tmpdir(),"dsh-portable-resources-fixture-"));try{const sessions=join(root,"native-spaces","a".repeat(64),"sessions");await mkdir(sessions,{recursive:true});const r=materializePortableV3(header,fixture());const payload={...r.artifact,portableAttachments:r.attachments} as any;await preparePortableResources(payload,sessions);await preparePortableResources(payload,sessions);const ref=r.attachments[0]!.ref,digest=String(ref.attachmentId).slice(7),file=join(sessions,"..","attachments","v1","objects",digest.slice(0,2),digest);expect(await readFile(file)).toEqual(Buffer.from(png,"base64"));await writeFile(file,"corrupt");await expect(preparePortableResources(payload,sessions)).rejects.toThrow(/differs/);await expect(preparePortableResources(payload,join(root,"unowned"))).rejects.toThrow(/Broker-owned/);}finally{await rm(root,{recursive:true,force:true});}});
 it("roundtrips V3 bytes and rejects tampered attachment inventories",async()=>{const source=fixture();let p:any;await materializeV3({run:{id:"run",instanceId:"instance",profileId:"web"},workspaces:[],sessions:[{session:{id:"synthetic",createdAt:"2026-09-12T00:00:00Z",updatedAt:"2026-09-12T00:00:00Z",headVersionId:"v1",tags:[]},events:source,workspaceId:null}]} as any,{writeWorkspace:async()=>{},writeSession:async(_id,value)=>{p=value;}});const description={header:p.header,relativePath:"memory-only"};const bytes=v3NativeSessionCodec.encode(p,description);v3NativeSessionCodec.verifyEncoded!(bytes,p,description);expect(restorePortableCanonical(p)).toEqual(source);expect(()=>validatePortableAttachments({...p,portableAttachments:[{...p.portableAttachments[0],base64:"YQ=="}]})).toThrow(/digest/);});
});
