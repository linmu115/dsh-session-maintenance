import type { SessionFormatEvent, SessionFormatJsonValue, SessionFormatJsonObject } from "@deepseek-ai/dsh-session-format";
import { count, record } from "./common.js";
/** Audited same-artifact coordinate vocabulary; captured foreign generations remain unchanged.
 * Based on dsh fb2c4b9 session-format-v2-to-v3/src/references.ts and V3 payload vocabulary. */
export function remap(event: SessionFormatEvent, seq: number, mapping: readonly (number | undefined)[]): SessionFormatEvent {
 const one = (v: unknown) => { const n=count(v,"source seq"), target=mapping[n]; if(n>=event.seq || target===undefined) throw new TypeError(`Unmapped reference ${n} at ${event.seq}`); return target; };
 const list = (v: unknown) => { if(!Array.isArray(v)) throw new TypeError("Expected seq list"); return v.map(one); };
 const range = (v: unknown) => { const r=record(v); return r.startSeq!==undefined ? {...r,startSeq:one(r.startSeq),endSeq:one(r.endSeq)} : {...r,start:one(r.start),end:one(r.end)}; };
 let data=event.data;
 const objectData=event.data!==null&&typeof event.data==="object"&&!Array.isArray(event.data)?event.data as SessionFormatJsonObject:undefined;
 if(event.type==="command/done" && objectData?.sourceEventSeq!==undefined) data={...objectData,sourceEventSeq:one(objectData.sourceEventSeq)};
 if(["compaction/summary","compaction/prune","compact/summary","compact/prune"].includes(event.type)){const value=record(data);data={...value,...(value.shadowedRange===undefined?{}:{shadowedRange:range(value.shadowedRange)}),...(value.shadowedSeqs===undefined?{}:{shadowedSeqs:list(value.shadowedSeqs)})};}
 if(["session/title","session/title-llm-request"].includes(event.type) && objectData?.messageSeqs!==undefined) data={...objectData,messageSeqs:list(objectData.messageSeqs)};
 return {...event,seq,data,...(event.sourceEventSeqs===undefined?{}:{sourceEventSeqs:list(event.sourceEventSeqs)}),...(event.surfaceOp===undefined||event.surfaceOp==="append"?{}:{surfaceOp:range(event.surfaceOp)})};
}
export function assertInformational(event: SessionFormatEvent): void {
 if(event.type!=="dsh-runtime/detail" || event.surfaceOp!==undefined || event.sourceEventSeqs!==undefined) throw new TypeError(`Unclassified information event ${event.type}`);
 const check=(v:SessionFormatJsonValue):void=>{ if(Array.isArray(v)){v.forEach(check);return;} if(v!==null&&typeof v==="object") for(const [k,x] of Object.entries(v)){ if(/(?:seq|offset|range|cursor)$/iu.test(k)) throw new TypeError(`Informational payload requires an explicit reference converter: ${k}`);check(x); } };
 check(event.data);
}
