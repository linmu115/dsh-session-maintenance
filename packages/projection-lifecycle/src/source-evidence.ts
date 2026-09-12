import { NATIVE_SOURCE_EXPORT_DIGEST_ALGORITHM, serializeNativeSourceExport } from "@linmu/dsh-session-contracts";
import { createHash } from "node:crypto";
import type { AdapterEvidencePort, CanonicalEventV1, CanonicalProjectionInput, CanonicalProjectionSource, DshSessionAdapterV1, IncrementalCanonicalProjectionSource, NativeSourceExportV1, SessionVersionId } from "@linmu/dsh-session-contracts";
export type SourceAdapterResolver = (event:CanonicalEventV1)=>DshSessionAdapterV1|undefined;
function digest(value:unknown):string{return `sha256:${createHash("sha256").update(serializeNativeSourceExport(value)).digest("hex")}`;}
/** Source owners alone receive scoped evidence reads. Target receives immutable, hashed exports. */
export function sourceWithEvidence(source:CanonicalProjectionSource,adapter:DshSessionAdapterV1,evidence?:AdapterEvidencePort,resolveOwner?:SourceAdapterResolver):CanonicalProjectionSource {
 if(!evidence)return source;
 const restore=async(events:readonly CanonicalEventV1[],version:SessionVersionId|null)=>{
  if(!adapter.acceptsSourceExports)return {events:adapter.restoreNativeEvents?await adapter.restoreNativeEvents(events,evidence):events,exports:[]};
  const groups=new Map<DshSessionAdapterV1,CanonicalEventV1[]>();
  for(const event of events){const owner=resolveOwner?.(event)??(adapter.ownsCanonicalEvent?.(event)?adapter:undefined);if(owner){const group=groups.get(owner)??[];group.push(event);groups.set(owner,group);}else if(event.kind==="other"&&event.source.platform==="dsh"&&event.rawPayload===null)throw new TypeError(`Source owner is unavailable for ${event.id}`);}
  const replacements=new Map<string,CanonicalEventV1>(),exports:NativeSourceExportV1[]=[];
  for(const [owner,group] of groups){
   const scoped:Pick<AdapterEvidencePort,"readEvidence">={readEvidence:(ref,id)=>{if(id!==owner.manifest.id)throw new TypeError("Source export attempted a foreign evidence read");return evidence.readEvidence(ref,id);}};
   const restored=owner.restoreNativeEvents?await owner.restoreNativeEvents(group,scoped):group;
   if(restored.length!==group.length||restored.some((e,i)=>e.id!==group[i]!.id))throw new TypeError("Source owner changed canonical identities during export");
   restored.forEach(e=>replacements.set(e.id,e));
   const metadata=restored.find(e=>e.extensions.nativeHeader!==undefined)?.extensions;
   exports.push({schemaVersion:1,digestAlgorithm:NATIVE_SOURCE_EXPORT_DIGEST_ALGORITHM,adapterId:owner.manifest.id,nativeFormatId:owner.nativeSessionCodec?.formatId??owner.manifest.id,canonicalVersion:version,contentDigest:digest(restored),events:restored,...(metadata?.nativeHeader===undefined?{}:{header:metadata.nativeHeader,...(typeof metadata.inheritedEventCount==="number"?{inheritedEventCount:metadata.inheritedEventCount}:{})})});
  }
  return {events:events.map(e=>replacements.get(e.id)??e),exports};
 };
 const project=async(input:CanonicalProjectionInput):Promise<CanonicalProjectionInput>=>({...input,sessions:await Promise.all(input.sessions.map(async item=>{const value=await restore(item.events,item.session?.headVersionId??null);return {...item,events:value.events,...(adapter.acceptsSourceExports?{nativeSourceExports:value.exports}:{})};}))});
 const incremental=source as Partial<IncrementalCanonicalProjectionSource>;
 return {load:async run=>project(await source.load(run)),...(source.loadVersionEvents?{loadVersionEvents:async(id,version)=>(await restore(await source.loadVersionEvents!(id,version),version)).events}:{}),...(incremental.currentRevision&&incremental.listChanges&&incremental.loadSessions?{currentRevision:()=>incremental.currentRevision!(),listChanges:(input:Parameters<IncrementalCanonicalProjectionSource["listChanges"]>[0])=>incremental.listChanges!(input),loadSessions:async(...args:Parameters<IncrementalCanonicalProjectionSource["loadSessions"]>)=>project(await incremental.loadSessions!(...args))}:{})};
}
