import { canonicalEventProjectionPolicy, readCanonicalConversationTopologyV1, type CanonicalEventV1, type JsonValue } from "@linmu/dsh-session-contracts";
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatHeader } from "@deepseek-ai/dsh-session-format";
import { digest, isRecord, record, type Obj } from "./common.js";
import { validateV3, visibleContext } from "./official.js";
import { messageIdentity, messageRecord, portableContent, type PortableAttachment } from "./portable-content.js";

export const PORTABLE_V3_CONVERTER = "dsh-0.1.5/canonical-v3-1";
const modelKind = (event: CanonicalEventV1) => ["assistant-message","tool-call"].includes(event.kind);
function topology(event: CanonicalEventV1) {
 const value=readCanonicalConversationTopologyV1(event);
 if (!value) throw new TypeError("Portable conversation requires canonical topology");
 const phase=event.kind==="user-message"?"user":event.kind==="assistant-message"?"assistant":event.kind;
 if (value.phase!==phase) throw new TypeError("Canonical topology phase differs from event kind");
 return value;
}
function callId(event: CanonicalEventV1): string { const id=record(event.content).callId; if(typeof id!=="string"||!id.length)throw new TypeError("Canonical tool event lacks exact callId");return id; }

/** Direct canonical projection. Source receipts remain individually ordered, including records with no model exposure. */
export function materializePortableV3(header: SessionFormatHeader, source: readonly CanonicalEventV1[]) {
 const events:SessionFormatEvent[]=[], seqMap:number[][]=[], attachments=new Map<string,PortableAttachment>(), aliases:Record<string,string>={};
 const mapping:{canonicalEventId:string;canonicalSequence:number;archiveSeq:number;messageId?:string}[]=[], ids=new Set<string>();
 let previous=-1, turn=0, step=0, turnId:string|undefined, stepId:string|undefined, openStep=false, assistantInStep=false, systemHead:number|undefined;
 const pending=new Map<string,number>(), completedCalls=new Set<string>();
 const emit=(type:string,data:JsonValue,time:number,surface=false)=>{const seq=events.length;events.push({type,data,seq,time,...(surface?{surfaceOp:"append" as const}:{})});return seq;};
 const alias=(from:string,to:string)=>{if(Object.hasOwn(aliases,from)&&aliases[from]!==to)throw new TypeError("Ambiguous canonical message alias");aliases[from]=to;};
 const identify=(id:string)=>{if(ids.has(id))throw new TypeError("Repeated portable message identity");ids.add(id);alias(id,id);};
 for(const event of source){if(!Number.isSafeInteger(event.sequence)||event.sequence<=previous||event.sequence<0)throw new TypeError("Canonical sequence must increase");previous=event.sequence;}
 const archive=(event:CanonicalEventV1)=>{
  const index=mapping.length, time=header.createdAt+event.sequence;
  const seq=emit(event.kind==="other"?"maintenance/other":"maintenance/canonical-event",{converter:PORTABLE_V3_CONVERTER,canonicalEvent:structuredClone(event) as unknown as JsonValue,canonicalContent:event.content,...canonicalEventProjectionPolicy(event.kind)} as unknown as JsonValue,time);
  events[seq]={...events[seq]!,ignorable:true};seqMap[index]=[seq];mapping.push({canonicalEventId:event.id,canonicalSequence:event.sequence,archiveSeq:seq});return index;
 };
 const closeStep=(time:number)=>{if(openStep){if(pending.size)throw new TypeError("Portable step has unresolved tool calls");emit("step/end",{turn,step},time);openStep=false;assistantInStep=false;}};
 const closeTurn=(time:number)=>{if(turnId!==undefined){closeStep(time);emit("turn/end",{turn,reason:{kind:"completed"}},time);turnId=undefined;stepId=undefined;}};
 const enter=(event:CanonicalEventV1,needsAssistant=false)=>{
  const t=topology(event), time=header.createdAt+event.sequence;
  if(turnId!==t.turnId){closeTurn(time);if(t.turnOrdinal!==turn)throw new TypeError("Canonical turn order is not dense");turn++;turnId=t.turnId;step=0;stepId=undefined;emit("turn/start",{turn},time);}
  if(openStep && (t.stepId!==null && stepId!==undefined && stepId!==t.stepId || needsAssistant && assistantInStep))closeStep(time);
  if(!openStep){step++;emit("step/start",{turn,step},time);openStep=true;assistantInStep=false;}
  if(t.stepId!==null)stepId=t.stepId;
  if(systemHead===undefined){const id=`mcsf-system:${header.id}`;identify(id);systemHead=emit("system/message",{turn,step,message:{id,role:"system",source:{kind:"plugin",plugin:"dsh-session-maintenance"},content:[]}},time,true);}
 };
 for(let i=0;i<source.length;){
  const event=source[i]!, time=header.createdAt+event.sequence;
  if(modelKind(event)){
   const first=topology(event), group:CanonicalEventV1[]=[];let messages=0;
   while(i<source.length){const next=source[i]!;if(!modelKind(next))break;const t=topology(next);if(t.turnId!==first.turnId||t.stepId!==first.stepId||next.kind==="assistant-message"&&messages>0)break;group.push(next);if(next.kind==="assistant-message")messages++;i++;}
   enter(event,true);
   const indices=group.map(archive), blocks:JsonValue[]=[];
   for(const item of group){
    if(item.kind==="tool-call"){const c=record(item.content),id=callId(item);if(pending.has(id)||completedCalls.has(id)||typeof c.name!=="string"||!c.name.length||typeof c.arguments!=="string")throw new TypeError("Invalid or duplicated canonical tool call");blocks.push({type:"tool-call",id,name:c.name,arguments:c.arguments});}
    else blocks.push(...portableContent(item,attachments));
   }
   const messageEvent=group.find(e=>e.kind==="assistant-message"), id=messageEvent?messageIdentity(messageEvent):`mcsf-assistant:${digest(group.map(e=>e.id)).slice(7)}`;identify(id);
   const existing=messageEvent?messageRecord(messageEvent):{}, model=isRecord(existing.source)&&existing.source.kind==="model"?existing.source:{kind:"model",provider:event.source.platform,model:"imported"};
   emit("assistant/message",{turn,step,message:{id,role:"assistant",source:model,content:blocks},stream:[]},header.createdAt+group.at(-1)!.sequence,true);assistantInStep=true;
   for(const [index,item]of group.entries()){alias(item.id,id);if(item.source.eventId)alias(item.source.eventId,id);if(item.kind==="assistant-message")alias(messageIdentity(item),id);mapping[indices[index]!]!.messageId=id;
    if(item.kind==="tool-call"){const c=record(item.content),call=callId(item);pending.set(call,emit("tool/call",{turn,step,callId:call,name:c.name!,arguments:c.arguments!},header.createdAt+item.sequence));}}
   continue;
  }
  if(event.kind==="user-message"){
   enter(event);const at=archive(event),id=messageIdentity(event);identify(id);alias(event.id,id);if(event.source.eventId)alias(event.source.eventId,id);
   emit("user/message",{id,role:"user",source:{kind:"user"},content:portableContent(event,attachments)},time,true);mapping[at]!.messageId=id;
  }else if(event.kind==="tool-result"){
   enter(event);const at=archive(event),call=callId(event),c=record(event.content);if(!pending.has(call)||typeof c.outputText!=="string")throw new TypeError("Canonical tool result has no matching live call");
   const id=messageIdentity(event);identify(id);alias(event.id,id);if(event.source.eventId)alias(event.source.eventId,id);
   emit("tool/result",{turn,step,message:{id,role:"user",source:{kind:"tool",callId:call},content:[{type:"tool-result",toolCallId:call,content:[{type:"text",text:c.outputText}],...(c.isError===true?{isError:true}:{})}]},meta:{canonicalContent:c}},time,true);
   pending.delete(call);completedCalls.add(call);mapping[at]!.messageId=id;
  }else if(event.kind==="system-message"){
   throw new TypeError("Portable system messages require an explicit system chronology converter");
  }else {
   if(canonicalEventProjectionPolicy(event.kind).modelExposure!=="log-only")throw new TypeError("Unclassified portable semantic event");archive(event);
  }
  i++;
 }
 closeTurn(header.createdAt+(source.at(-1)?.sequence??0));
 const artifact=validateV3({header:{...header,version:3},events,inheritedEventCount:0});
 // Also enforce Session's cold-read contracts, including identified messages and assistant streams.
 visibleContext(artifact);
 return {artifact,anchorAliases:aliases,attachments:[...attachments.values()],ledger:{converter:PORTABLE_V3_CONVERTER,sourceVersion:"canonical-v1",sourceDigest:digest(source),targetDigest:digest(artifact),seqMap,canonicalMapping:mapping,informational:[],knownEventCount:source.length}};
}

/** Recover every original canonical row from durable ordered receipts; generated execution scaffolding never becomes source history. */
export function restorePortableCanonical(artifact: SessionFormatArtifact): readonly CanonicalEventV1[] {
 const source:CanonicalEventV1[]=[];const ids=new Set<string>();
 for(const event of artifact.events){if(event.type!=="maintenance/canonical-event"&&event.type!=="maintenance/other")continue;const data=record(event.data);if(data.converter!==PORTABLE_V3_CONVERTER)continue;const value=record(data.canonicalEvent);if(typeof value.id!=="string"||ids.has(value.id)||typeof value.sequence!=="number"||value.sequence<=(source.at(-1)?.sequence??-1))throw new TypeError("Invalid canonical restoration receipt");ids.add(value.id);source.push(value as unknown as CanonicalEventV1);}
 return source;
}
