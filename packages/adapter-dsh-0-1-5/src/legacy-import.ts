import { admitAnnotationSources } from "./annotation-source.js";
import { sessionFormatV0ToV1 } from "@deepseek-ai/dsh-session-format-v0-to-v1";
import { sessionFormatV1ToV2 } from "@deepseek-ai/dsh-session-format-v1-to-v2";
import { sessionFormatV2ToV3 } from "@deepseek-ai/dsh-session-format-v2-to-v3";
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatMigration, SessionFormatMigrationStage } from "@deepseek-ai/dsh-session-format";
import { validateV3, knownEventTypes } from "./official.js";
import { count, digest, record } from "./common.js";
import { assertInformational } from "./references-remap.js";
export const CONVERTER_ID = "dsh-0.1.5/migration-2/fb2c4b9e698e30edb738bca4cf0618587db7d203";
export interface ConversionResult { readonly artifact: SessionFormatArtifact; readonly ledger: { readonly converter: string; readonly sourceDigest: string; readonly targetDigest: string; readonly sourceVersion: number; readonly seqMap: readonly (readonly number[])[]; readonly informational: readonly SessionFormatEvent[]; readonly knownEventCount: number; readonly annotationSources?: readonly unknown[]; readonly informationalPositions?: readonly {readonly sourceSeq:number;readonly targetSeq:number}[] } }
/** Pinned private provenance seam. Public migration stages perform every transformation.
 * Their RC2 maps are read ONLY to export source coordinates (never modified); fail on drift.
 * v1 chunks map to zero standalone rows because the official converter embeds them in streams.
 */
function coordinateMap(stage: SessionFormatMigrationStage, version: number, length: number): (number|undefined)[] {
 if(version===0) return Array.from({length},(_,i)=>i);
 if(version===1){ const state=Reflect.get(stage,"state"), map=state&&Reflect.get(state,"mapping"); if(!(map instanceof Map)) throw new Error("Pinned RC2 v1 provenance API drift");return Array.from({length},(_,i)=>map.get(i)); }
 const map=Reflect.get(stage,"mapping");if(!Array.isArray(map)||map.length!==length) throw new Error("Pinned RC2 v2 provenance API drift");return map.map(v=>count(v));
}
function edge(input: SessionFormatArtifact, migration: SessionFormatMigration) {
 const header=migration.migrateHeader(input.header), events:SessionFormatEvent[]=[];
 const stage=migration.createStage({sourceHeader:input.header,targetHeader:header,sourceInheritedEventCount:input.inheritedEventCount,sourceKind:"decoded"});
 const sink={emitEvent:(e:SessionFormatEvent)=>{events.push(e);},emitRun:(r:{expand():Iterable<SessionFormatEvent>})=>{events.push(...r.expand());}};
 const emitted:number[][]=[];
 for(const event of input.events){const begin=events.length;stage.transformEvent(event,sink);emitted[event.seq]=Array.from({length:events.length-begin},(_,i)=>begin+i);}
 const inheritedEventCount=stage.finish(sink), map=coordinateMap(stage,input.header.version,input.events.length);
 migration.validateTargetHeader(header);
 const provenance=map.map((n,i)=>input.header.version===2?emitted[i]!:(n===undefined?[]:[n]));
 return {artifact:{header,events,inheritedEventCount},map,provenance};
}
export function migrateLegacy(input: SessionFormatArtifact): ConversionResult {
 const sourceVersion=count(input.header.version,"format version");if(sourceVersion>3) throw new TypeError("Future Session generation refused");
 input.events.forEach((e,i)=>{if(e.seq!==i)throw new TypeError("Legacy source events must be contiguous");});
 if(sourceVersion===3){const artifact=validateV3(input);return {artifact,ledger:{converter:CONVERTER_ID,sourceDigest:digest(input),targetDigest:digest(artifact),sourceVersion,seqMap:input.events.map(e=>[e.seq]),informational:[],knownEventCount:input.events.length}};}
 // Carry only the audited non-surface detail through the official log-event buffering.
 // It is restored before V3 validation/publication. Keeping a row at the original coordinate lets
 // the official chunk converter preserve interleaving; filtering it out loses that information.
 const info:SessionFormatEvent[]=[], carriers=new Map<string,SessionFormatEvent>();
 const carrierPrefix="dsh-maintenance-detail-position:";
 const prepared=input.events.map(event=>{
  if(event.type==="feedback/record" && typeof record(event.data).text==="string" && (record(event.data).text as string).startsWith(carrierPrefix))throw new TypeError("Reserved detail position carrier collision");
  if(event.type!=="dsh-runtime/detail")return event;
  assertInformational(event);info.push(event);
  const text=carrierPrefix+digest({sourceVersion,event});carriers.set(text,event);
  return {type:"feedback/record",seq:event.seq,time:event.time,data:{text}};
 });
 const annotations=admitAnnotationSources(prepared);
 let artifact:SessionFormatArtifact={header:input.header,events:annotations.events,inheritedEventCount:input.inheritedEventCount};
 let maps=input.events.map(e=>[e.seq]);
 for(const migration of [sessionFormatV0ToV1,sessionFormatV1ToV2,sessionFormatV2ToV3]){
  if(migration.fromVersion<sourceVersion)continue;
  const next=edge(artifact,migration);maps=maps.map(row=>row.flatMap(n=>next.provenance[n]??[]));artifact=next.artifact;
 }
 const positions:{sourceSeq:number;targetSeq:number}[]=[],seen=new Set<string>();
 const restored=artifact.events.map(event=>{
  if(event.type!=="feedback/record")return event;
  const text=record(event.data).text;
  if(typeof text!=="string" || !text.startsWith(carrierPrefix))return event;
  const original=carriers.get(text);
  if(original===undefined || seen.has(text) || maps[original.seq]?.length!==1 || maps[original.seq]![0]!==event.seq)throw new TypeError("Detail position provenance changed during official migration");
  seen.add(text);positions.push({sourceSeq:original.seq,targetSeq:event.seq});
  return {...original,seq:event.seq,ignorable:true};
 });
 if(seen.size!==carriers.size)throw new TypeError("Detail information was lost during official migration");
 artifact=validateV3({...artifact,events:annotations.restore(restored)});
 return {artifact,ledger:{converter:CONVERTER_ID,sourceDigest:digest(input),targetDigest:digest(artifact),sourceVersion,seqMap:maps,informational:info,knownEventCount:input.events.length-info.length,...(annotations.ledger.length?{annotationSources:annotations.ledger}:{}),...(positions.length?{informationalPositions:positions}:{})}};
}
