import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionFormatEvent } from "@deepseek-ai/dsh-session-format";
import { adapter as ordinary, validateV3Artifact, REQUIRED_CAPABILITIES, V3RuntimeBridge } from "@linmu/dsh-session-adapter-0-1-5";
import { adapter, catalog, probe, validateArtifact, CAPABILITY, FORMAT_ID, recoverRuntimeTail, createRuntimeBridge } from "../src/index.js";

const header = { version:3, id:"gpt-fixture", createdAt:1, delegationDepth:0, isSeeded:false };
const rows: SessionFormatEvent[] = [
  {type:"context/operation",seq:0,time:1,data:{kind:"native-compact",request:{input:[]}}},
  {type:"context/operation-result",seq:1,time:2,data:{operation:0,output:[{type:"compaction",encrypted_content:"opaque-fixture"}]}},
  {type:"context/checkpoint",seq:2,time:3,data:{key:"gpt",state:{coveredThrough:0,input:[{type:"compaction",encrypted_content:"opaque-fixture"}]}}},
  {type:"context/checkpoint-commit",seq:3,time:4,data:{checkpoint:2}},
  {type:"request/projection",seq:4,time:5,data:{messages:[],adapterContext:{format:"responses",scope:"test",input:[]}}},
];
const artifact = () => ({header,events:structuredClone(rows),inheritedEventCount:0});
const environment = () => ({dshVersion:"0.1.5-rc.2",packageVersions:Object.fromEntries(["@deepseek-ai/dsh-session","@deepseek-ai/dsh-session-persistence","@deepseek-ai/dsh-session-format-catalog"].map(x=>[x,"0.1.5-rc.2"]).concat([["dsh-gpt-compat","0.5.0-dev.3"]])),runtimeCapabilities:[...REQUIRED_CAPABILITIES,CAPABILITY]}) as Parameters<typeof probe>[0];

it("composes plugin events under the existing Harness identity without mutating the bare decoder", () => {
  expect(adapter.manifest.id).toBe("dsh-0.1.5");
  expect(adapter.nativeSessionCodec!.formatId).toBe(FORMAT_ID);
  expect(ordinary.nativeSessionCodec!.formatId).toBe("dsh-0.1.5-v3-jsonl-zstd-v1");
  expect(validateArtifact(artifact())).toEqual(artifact());
  expect(()=>validateV3Artifact(artifact())).toThrow(/unknown event/);
  expect(probe(environment()).status).toBe("verified");
  expect(probe({...environment(),packageVersions:{...environment().packageVersions,"dsh-gpt-compat":"0.5.0-dev.4"}}).status).toBe("verified");
  expect(probe({...environment(),runtimeCapabilities:REQUIRED_CAPABILITIES}).status).toBe("failed");
  expect(probe({...environment(),packageVersions:{...environment().packageVersions,"dsh-gpt-compat":"0.6.0"}}).status).toBe("failed");
});
it.each([
  {type:"request/projection",data:{messages:null,adapterContext:{format:"responses",scope:"x",input:[]}}},
  {type:"context/checkpoint-commit",data:{checkpoint:0}},
  {type:"context/operation-result",data:{operation:2,output:{}}},
  {type:"context/checkpoint",data:{key:""}},
  {type:"future/required",data:{}},
])("refuses malformed or unowned event $type", event => {
  const value=artifact();value.events[4]={...event,seq:4,time:5} as SessionFormatEvent;
  expect(()=>validateArtifact(value)).toThrow();
});
it("keeps opaque bytes and sequence identities through compression and normalization", async () => {
  const a=artifact(), codec=adapter.nativeSessionCodec!, description={header,relativePath:"fixture"};
  const bytes=codec.encode(a as never,description);await codec.verifyEncoded!(bytes,a as never,description);
  const normalized=await adapter.normalizeAppend({runId:"run",operationId:"append",nativeSessionId:header.id,nativeRevision:5,observedAt:"2026-09-17T00:00:00Z",payload:{...a,logicalSessionId:"logical",instanceId:"instance"}} as never);
  expect(normalized.events.map(e=>e.rawPayload)).toEqual(rows);
  expect(normalized.events.every(e=>e.extensions.adapterId==="dsh-0.1.5"&&e.extensions.nativeFormatId===FORMAT_ID)).toBe(true);
  expect(normalized.events.every(e=>e.id.startsWith("dsh-0.1.5:"))).toBe(true);
  expect(normalized.events.every(e=>e.extensions.extensionNamespace==="gpt-compat")).toBe(true);
  expect(()=>ordinary.nativeSessionCodec!.encode(a as never,description)).toThrow(/unknown event/);
});
it("isolates asynchronous materializations and recovers a durable native tail", async () => {
  const root=await mkdtemp(join(tmpdir(),"synthetic-gpt-adapter-"));
  try {
    const codec=adapter.nativeSessionCodec!, description=await codec.describe!({header,events:rows,inheritedEventCount:0} as never,root);
    const path=join(root,description.relativePath);await mkdir(dirname(path),{recursive:true});
    const a={...artifact(),header:description.header};await writeFile(path,codec.encode(a as never,description));
    const recovery=recoverRuntimeTail({runId:"run" as never,persistenceRoot:root,sessions:[{nativeSessionId:header.id as never,logicalSessionId:"logical" as never,baseVersionId:null,nativeRevision:2,header:description.header,committedEvents:rows.slice(0,2) as never,instanceId:"instance"}],observedAt:"2026-09-17T00:00:00Z"});
    expect(()=>validateV3Artifact(artifact())).toThrow(/unknown event/);
    const tail=await recovery;expect((tail[0]!.payload as {events:unknown[]}).events).toEqual(rows.slice(2));
    expect(ordinary.nativeSessionCodec!.formatId).toBe(FORMAT_ID);
  } finally {await rm(root,{recursive:true,force:true});}
});
it("binds runtime handles to the DSH Harness", async () => {
  const registrar={attach:async()=>({registrationId:"r",attachedAt:"2026-09-17T00:00:00Z"}),drain:async()=>({drained:true}),detach:async()=>{}};
  const bridge=createRuntimeBridge(registrar as never);
  const handle=await bridge.attach({run:{id:"run",adapterId:"dsh-0.1.5"},maintenanceEndpoint:"http://127.0.0.1"} as never);
  expect(handle.adapterId).toBe("dsh-0.1.5");
  const ordinaryBridge=new V3RuntimeBridge(registrar as never);
  expect((await ordinaryBridge.attach({run:{id:"ordinary"},maintenanceEndpoint:"http://127.0.0.1"} as never)).adapterId).toBe("dsh-0.1.5");
  await expect(bridge.drain({...handle,adapterId:"another-harness" as never})).rejects.toThrow("another Adapter");
});

it("materializes a normalized plugin session twice without losing private checkpoints",async()=>{
 const normalize=()=>adapter.normalizeAppend({runId:"run",operationId:"append",nativeSessionId:header.id,nativeRevision:5,observedAt:"2026-09-17T00:00:00Z",payload:{...artifact(),logicalSessionId:"logical",instanceId:"instance"}} as never);
 const events=(await normalize()).events;
 const item={session:{id:"logical",headVersionId:"version",createdAt:"2026-09-17T00:00:00Z",updatedAt:"2026-09-17T00:00:00Z",title:"fixture",tags:[]},events,workspaceId:null,projectRoot:null};
 let payload:any;
 await adapter.materialize({run:{id:"run",adapterId:"dsh-0.1.5",instanceId:"instance",profileId:"web"},sessions:[item],workspaces:[]} as never,{writeWorkspace:async()=>{},writeSession:async(_id:unknown,p:unknown)=>{payload=p;}} as never);
 expect(payload.events).toEqual(rows);
 expect(adapter.projectedNativeRevision!(item as never,payload)).toBe(rows.length);
 expect(()=>validateV3Artifact(payload)).toThrow(/unknown event/);
});
