import type { AdapterEvidencePort, CanonicalAppendOperation, CanonicalEventV1, JsonValue, NativeAppendOperation, LogicalSessionId, SessionVersionId } from "@linmu/dsh-session-adapter-sdk";
import type { SessionFormatEvent } from "@deepseek-ai/dsh-session-format";
import { count, digest, record, FORMAT_ID } from "./common.js";
import { KNOWN_SESSION_EVENT_TYPES, validateV3Events } from "./official.js";
import { assertInformational } from "./references-remap.js";
import { parseV3LogicalSessionHeader, validateV3Lineage } from "./lineage.js";
import { manifest } from "./manifest.js";
export async function normalizeV3Append(operation:NativeAppendOperation, evidence?:AdapterEvidencePort):Promise<CanonicalAppendOperation> {
 const payload=record(operation.payload);if(typeof payload.logicalSessionId!=="string"||!Array.isArray(payload.events)||typeof payload.instanceId!=="string")throw new TypeError("V3 append requires logicalSessionId, instanceId and events");
 const header=parseV3LogicalSessionHeader(payload.header,operation.nativeSessionId);validateV3Lineage(header,count(payload.inheritedEventCount));
 const end=count(operation.nativeRevision), start=end-payload.events.length;if(start<0)throw new TypeError("V3 revision is shorter than append");
 const events:CanonicalEventV1[]=[];
 for(const [index,value] of payload.events.entries()) {
  const raw=record(value), event=raw as unknown as SessionFormatEvent;
  if(event.seq!==start+index)throw new TypeError("V3 append must be a contiguous logical prefix tail");
  const known=KNOWN_SESSION_EVENT_TYPES.has(event.type as never);
  let evidenceRef:string|null=null;
  if(!known) {
   if(!evidence)throw new TypeError("Unknown V3 event requires durable evidence storage");
   evidenceRef=(await evidence.putEvidence({schemaVersion:1,adapterId:manifest.id,nativeFormatId:FORMAT_ID,sourceKind:`dsh-0.1.5/${event.type}`,payload:value,observedAt:operation.observedAt})).ref;
   assertInformational(event);if(event.ignorable!==true)throw new TypeError("Unmarked V3 information event refused");
  }
  validateV3Events([event]);
  const kind:CanonicalEventV1["kind"]=!known?"other":event.type==="user/message"?"user-message":event.type==="assistant/message"?"assistant-message":event.type==="tool/call"?"tool-call":event.type==="tool/result"?"tool-result":"system-metadata";
  const role:CanonicalEventV1["role"]=kind==="user-message"?"user":kind==="assistant-message"||kind==="tool-call"?"assistant":kind==="tool-result"?"tool":!known?"unknown":"system";
  const content:JsonValue=known?event.data:{schemaVersion:1,type:"other",reason:"adapter-evidence",sourceKind:`dsh-0.1.5/${event.type}`,label:"原生信息事件",summary:event.type,evidenceRef};
  events.push({schemaVersion:1,id:`dsh-0.1.5:${operation.runId}:${operation.nativeSessionId}:${event.seq}`,logicalSessionId:payload.logicalSessionId as LogicalSessionId,sequence:event.seq,kind,role,content,contentDigest:digest(content),rawPayload:known?value:null,
   source:{platform:"dsh",instanceId:payload.instanceId,sessionId:operation.nativeSessionId,eventId:String(event.seq),cursor:String(end)},
   extensions:{adapterId:manifest.id,nativeFormatId:FORMAT_ID,nativeFormatVersion:3,dshEventType:event.type,...(payload.header===undefined?{}:{nativeHeader:payload.header,inheritedEventCount:payload.inheritedEventCount??0}),...(!known?{heldOut:true}:{})}});
 }
 return {runId:operation.runId,operationId:operation.operationId,nativeSessionId:operation.nativeSessionId,logicalSessionId:payload.logicalSessionId as LogicalSessionId,baseVersionId:typeof payload.baseVersionId==="string"?payload.baseVersionId as SessionVersionId:null,events,metadata:{nativeRevision:end,nativeFormatVersion:3,nativeFormatId:FORMAT_ID,observedAt:operation.observedAt,canonicalHistoryMode:"native",...(payload.header===undefined?{}:{nativeHeader:payload.header,inheritedEventCount:payload.inheritedEventCount??0})}};
}
