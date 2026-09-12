import type { CanonicalProjectionInput, CanonicalProjectionSessionInput, JsonValue, ProjectionManifest, ProjectionManifestCompositionInput, ProjectionWriter } from "@linmu/dsh-session-adapter-sdk";
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatHeader } from "@deepseek-ai/dsh-session-format";
import { materializeRc1, rc1NativeSessionId } from "@linmu/dsh-session-adapter-rc1";
import { digest, record, isRecord, count, FORMAT_ID } from "./common.js";
import { migrateLegacy } from "./legacy-import.js";
import { validateV3 } from "./official.js";
import { manifest } from "./manifest.js";
export { rc1NativeSessionId as v3NativeSessionId };
export { digest } from "./common.js";
export function catalogDigest(sessionDigests:Readonly<Record<string,string>>, workspaceIds:readonly string[]):string {return digest({sessions:Object.entries(sessionDigests).sort(([a],[b])=>a.localeCompare(b)),workspaces:[...new Set(workspaceIds)].sort()});}
export function composeV3ProjectionManifest(input:ProjectionManifestCompositionInput):ProjectionManifest {return {schemaVersion:1,runId:input.run.id,adapterId:manifest.id,sessionCount:Object.keys(input.sessionDigests).length,workspaceCount:new Set(input.workspaceIds).size,catalogDigest:catalogDigest(input.sessionDigests,input.workspaceIds),sessionDigests:input.sessionDigests};}
function canonicalDigest(item:CanonicalProjectionSessionInput):string {return digest(item.events.map(e=>({id:e.id,contentDigest:e.contentDigest,source:e.source,rawPayload:e.rawPayload})));}
export function v3ProjectedNativeRevision(item:CanonicalProjectionSessionInput,value:JsonValue):number {
 const payload=record(value);if(!Array.isArray(payload.events))throw new TypeError("V3 projection events are missing");
 if(payload.conversionLedger===undefined){
  // Runtime-created sessions have no legacy conversion prefix; every canonical row must attest a V3 native row.
  const events=item.events.map((e,i)=>{const raw=record(e.rawPayload);if(e.extensions.nativeFormatVersion!==3||raw.seq!==i)throw new TypeError("Runtime projection lacks a verified V3 canonical prefix");return raw;});
  if(payload.events.length<events.length||digest(payload.events.slice(0,events.length))!==digest(events))throw new TypeError("Runtime projection prefix differs from canonical");return events.length;
 }
 const ledger=record(payload.conversionLedger);
 const canonicalCount=count(ledger.canonicalEventCount), prefix=count(ledger.nativeRevision);
 if(item.events.length<canonicalCount||ledger.canonicalDigest!==canonicalDigest({...item,events:item.events.slice(0,canonicalCount)}))throw new TypeError("V3 canonical source differs from conversion receipt");
 if(payload.events.length<prefix||digest(payload.events.slice(0,prefix))!==ledger.eventsDigest)throw new TypeError("V3 committed projection prefix differs from conversion receipt");
 const tail=item.events.slice(canonicalCount).map((e,i)=>{const raw=record(e.rawPayload);if(e.extensions.nativeFormatVersion!==3||raw.seq!==prefix+i)throw new TypeError("Unverified canonical V3 tail");return raw;});
 if(payload.events.length<prefix+tail.length||digest(payload.events.slice(prefix,prefix+tail.length))!==digest(tail))throw new TypeError("V3 canonical tail differs from projection");return prefix+tail.length;
}
export async function materializeV3(input:CanonicalProjectionInput,output:ProjectionWriter):Promise<ProjectionManifest> {
 const sessionDigests:Record<string,string>={};
 for(const workspace of input.workspaces)await output.writeWorkspace(workspace.id,{schemaVersion:1,id:workspace.id,parentId:workspace.parentId,name:workspace.name,sortKey:workspace.sortKey,deletedAt:workspace.deletedAt});
 for(const item of input.sessions) {
  const nativeId=rc1NativeSessionId(item.session.id), createdAt=Date.parse(item.session.createdAt);count(createdAt,"createdAt");
  let base:Record<string,JsonValue>={schemaVersion:1,logicalSessionId:item.session.id,baseVersionId:item.session.headVersionId,projectId:item.projectId??null,projectTitle:item.projectName??null,workspaceId:item.workspaceId,updatedAt:item.session.updatedAt,title:item.session.title,tags:[...item.session.tags],canonicalHistoryMode:"native"};
  const firstV3=item.events.findIndex(e=>e.extensions.nativeFormatVersion===3), prefix=firstV3<0?item.events:item.events.slice(0,firstV3), tail=firstV3<0?[]:item.events.slice(firstV3);
  if(tail.some(e=>e.extensions.nativeFormatVersion!==3))throw new TypeError("Mixed format epochs must be contiguous");
  const rawNative=prefix.every(e=>isRecord(e.rawPayload)&&typeof e.rawPayload.type==="string"&&! ["text-chunks","reasoning-chunks","tool-call-chunks"].includes(e.rawPayload.type)&&Number.isSafeInteger(e.rawPayload.seq));
  let header:SessionFormatHeader={version:0,id:nativeId,createdAt,delegationDepth:0,isSeeded:false,...(item.projectRoot?{cwd:item.projectRoot}:{})}, raw:readonly SessionFormatEvent[];
  const exported=item.nativeSourceExports??[];
  for(const source of exported)if(source.contentDigest!==digest(source.events))throw new TypeError("Source-owner export digest mismatch");
  const nativeHeader=exported.find(e=>e.header!==undefined)?.header??item.events.find(e=>e.extensions.nativeHeader!==undefined)?.extensions.nativeHeader;
  let cut=exported.find(e=>e.header!==undefined)?.inheritedEventCount??item.events.find(e=>e.extensions.nativeHeader!==undefined)?.extensions.inheritedEventCount??0;
  if(nativeHeader!==undefined)header={...record(nativeHeader),id:nativeId,version:firstV3===0?3:Number(prefix[0]?.extensions.nativeFormatVersion??0)} as unknown as SessionFormatHeader;
  if(firstV3===0){header={...header,version:3};raw=[];cut=header.isSeeded?count(cut):0;}
  else if(rawNative)raw=prefix.map(e=>e.rawPayload as unknown as SessionFormatEvent);
  else {
   if(prefix.some(e=>e.kind==="other"&&e.rawPayload===null&&e.source.platform==="dsh"))throw new TypeError("Native source evidence must be restored by its owner before conversion");
   let portable:JsonValue|undefined;
   await materializeRc1({...input,workspaces:[],sessions:[{...item,events:prefix}]},{writeWorkspace:async()=>{},writeSession:async(_id,payload)=>{portable=payload;}});
   const previous=record(portable);base={...base,anchorAliases:previous.anchorAliases??{}};raw=previous.events as unknown as SessionFormatEvent[];
  }
  const converted=firstV3===0?undefined:migrateLegacy({header,events:raw,inheritedEventCount:count(cut)});
  const all=[...(converted?.artifact.events??[]),...tail.map(e=>{if(!isRecord(e.rawPayload))throw new TypeError("V3 event evidence is unavailable");return e.rawPayload as unknown as SessionFormatEvent;})];
  const artifact=validateV3({header:converted?.artifact.header??header,events:all,inheritedEventCount:converted?.artifact.inheritedEventCount??count(cut)});
  const legacyAliases=[...new Set(item.events.map(e=>e.source.sessionId).filter(id=>id!==nativeId))];
  const payload={...base,instanceId:input.run.instanceId,profileId:input.run.profileId,runId:input.run.id,nativeFormatVersion:3,nativeFormatId:FORMAT_ID,header:artifact.header,events:artifact.events,inheritedEventCount:artifact.inheritedEventCount,legacyNativeSessionIds:legacyAliases,
   conversionLedger:{...(converted?.ledger??{}),canonicalDigest:canonicalDigest(item),canonicalEventCount:item.events.length,eventsDigest:digest(artifact.events),nativeRevision:artifact.events.length,sourceExports:exported.map(({events,...receipt})=>receipt)}};
  await output.writeSession(nativeId,payload as unknown as JsonValue);sessionDigests[nativeId]=digest(payload);
 }
 return composeV3ProjectionManifest({run:input.run,sessionDigests,workspaceIds:input.workspaces.map(w=>w.id)});
}
