import { NATIVE_SOURCE_EXPORT_DIGEST_ALGORITHM, serializeNativeSourceExport } from "@linmu/dsh-session-contracts";
import { verifySourceExport } from "../../adapter-dsh-0-1-5/src/common.js";
import {describe,it,expect} from "vitest";
import {sourceWithEvidence} from "../src/source-evidence.js";
import {adapter as rc1,normalizeRc1Append} from "../../adapter-dsh-rc1/src/index.js";
import {adapter as v3} from "../../adapter-dsh-0-1-5/src/index.js";
import {materializeV3} from "../../adapter-dsh-0-1-5/src/materialize.js";
const at="2026-09-12T00:00:00.000Z",run={id:"run",instanceId:"instance",profileId:"web",adapterId:"dsh-0.1.5"};
describe("source-owner exports for V3",()=>{
 it("restores old-owned detail evidence through the old adapter and leaves canonical source immutable",async()=>{
  const saved=new Map<string,any>(),reads:string[]=[];const evidence={putEvidence:async(value:any)=>{const ref=`evidence-${saved.size}`;saved.set(ref,value);return {ref}},readEvidence:async(ref:string,owner:string)=>{reads.push(owner);const value=saved.get(ref);if(value.adapterId!==owner)throw new Error("owner mismatch");return value}} as any;
  const raw={type:"dsh-runtime/detail",seq:0,time:1,data:{id:"retained-card",items:[],state:"completed"}};
  const canonical=await normalizeRc1Append({runId:"old-run",operationId:"old-op",nativeSessionId:"old-native",nativeRevision:1,observedAt:at,payload:{instanceId:"old-instance",logicalSessionId:"logical",events:[raw]}} as any,evidence);
  const historicalReceipt=await evidence.putEvidence({schemaVersion:1,adapterId:"dsh-rc1",nativeFormatId:"dsh/0.1.2-rc.1/session-event-v1",sourceKind:"dsh-rc1/dsh-runtime/detail",payload:raw,observedAt:at});
  const historical={...canonical.events[0]!,kind:"other",rawPayload:null,content:{sourceKind:"dsh-rc1/dsh-runtime/detail",evidenceRef:historicalReceipt.ref},extensions:{dshEventType:"dsh-runtime/detail",heldOut:true}};
  const input={run,workspaces:[],sessions:[{session:{id:"logical",headVersionId:"version",createdAt:at,updatedAt:at,title:"fixture",tags:[]},workspaceId:null,projectRoot:null,events:[historical]}]} as any;
  const original=JSON.stringify(input),source=sourceWithEvidence({load:async()=>input},v3,evidence,()=>rc1);const exported=await source.load(run as any);
  expect(reads).toEqual(["dsh-rc1"]);expect(exported.sessions[0]!.nativeSourceExports?.[0]).toMatchObject({adapterId:"dsh-rc1",canonicalVersion:"version"});expect(JSON.stringify(input)).toBe(original);
  let payload:any;await materializeV3(exported,{writeWorkspace:async()=>{},writeSession:async(_id,p)=>{payload=p}});expect(payload.events).toContainEqual({...raw,ignorable:true});expect(payload.conversionLedger.sourceExports[0].contentDigest).toMatch(/^sha256:/);expect(JSON.stringify(input)).toBe(original);
 });
 it("refuses a source owner trying to read another adapter's evidence",async()=>{
  const event={id:"owned",kind:"other",source:{platform:"dsh"},rawPayload:null};const owner={...rc1,restoreNativeEvents:async(events:any,port:any)=>{await port.readEvidence("ref","dsh-0.1.5");return events}};
  const source=sourceWithEvidence({load:async()=>({run,sessions:[{events:[event]}],workspaces:[]})} as any,v3,{readEvidence:async()=>{throw new Error("must not reach store")}} as any,()=>owner);
  await expect(source.load(run as any)).rejects.toThrow("foreign evidence read");
 });
});

it("uses the same versioned UTF-16 digest contract for exporter and consumer", async () => {
 const event = {id:"case-order",kind:"other",extensions:{},source:{platform:"dsh"},rawPayload:{a:1,A:2,_:3,z:[{b:1,B:2}]}};
 const owner = {...rc1,restoreNativeEvents:async(events:any)=>events};
 const input = {run,workspaces:[],sessions:[{session:{headVersionId:"v"},events:[event]}]} as any;
 const exported = await sourceWithEvidence({load:async()=>input},v3,{readEvidence:async()=>{throw Error("unused")}} as any,()=>owner).load(run as any);
 const receipt=exported.sessions[0]!.nativeSourceExports![0]!;
 expect(receipt.digestAlgorithm).toBe(NATIVE_SOURCE_EXPORT_DIGEST_ALGORITHM);
 expect(serializeNativeSourceExport({a:1,A:2,_:3})).toBe('{"A":2,"_":3,"a":1}');
 expect(()=>verifySourceExport(receipt)).not.toThrow();
 expect(()=>verifySourceExport({...receipt,digestAlgorithm:undefined} as any)).toThrow(/algorithm/);
 expect(()=>verifySourceExport({...receipt,events:[{...event,rawPayload:{changed:true}}]} as any)).toThrow(/digest mismatch/);
});
