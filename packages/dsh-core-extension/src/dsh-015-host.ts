import { createHash } from "node:crypto";
import { canonicalJson } from "@linmu/dsh-session-domain";
import type { DshCoreHost, DshNativeEvent, DshNativeSessionHeader, DshSessionArtifactCapture, DshSessionArtifactSnapshot } from "./types.js";
import type { Dsh015CoreContractObservation } from "./dsh-015-contract.js";
export interface Dsh015SessionHandle {
 readonly id:string;readonly header:DshNativeSessionHeader;readonly inheritedEventCount:number;readonly access:"read"|"write";
 read(offset?:number,length?:number):Promise<{readonly events:readonly DshNativeEvent[]}>;
 append(events:readonly DshNativeEvent[]):Promise<void>;flush():Promise<void>;close():Promise<void>;
}
export interface Dsh015SessionPersistence {
 stat(id:string):Promise<{readonly header:DshNativeSessionHeader;readonly revision:unknown}|undefined>;
 list():Promise<readonly {readonly header:DshNativeSessionHeader;readonly revision:unknown}[]>;
 open(id:string,access:"read"|"write"):Promise<Dsh015SessionHandle>;
 create(header:DshNativeSessionHeader,options:{readonly inheritedEventCount:number}):Promise<Dsh015SessionHandle>;
}
export type Dsh015MetadataHost=Pick<DshCoreHost,"captureWorkspace"|"captureProjection"|"captureRuntime"|"attachWorkspace"|"setArchive"|"invalidateProjection"|"reconcileRuntime"|"restoreWorkspace"|"restoreProjection">;
export interface Dsh015CoreHostOptions {
 readonly persistence:Dsh015SessionPersistence;
 readonly isSessionLive:(id:string)=>boolean;
 readonly observation:()=>Promise<Dsh015CoreContractObservation>;
 readonly validateStoredEvents:(header:DshNativeSessionHeader,events:DshNativeEvent[])=>readonly DshNativeEvent[];
 readonly metadata:Dsh015MetadataHost;
 /** Host admission barrier excludes Agent startup and other Maintenance mutations for the whole transaction. */
 readonly withOfflineSession:<T>(id:string,action:()=>Promise<T>)=>Promise<T>;
 /** Managed offline storage owner restores the snapshot atomically; no deleted public persistence API is fabricated. */
 readonly restoreOfflineSession:(snapshot:DshSessionArtifactSnapshot)=>Promise<void>;
}
export class Dsh015CoreHost implements Omit<DshCoreHost,"observeContract"> {
 constructor(readonly options:Dsh015CoreHostOptions){}
 observeContract(){return this.options.observation();}
 isSessionLive(id:string){return this.options.isSessionLive(id);}
 private cold(id:string){if(this.isSessionLive(id))throw new Error(`DSH_BUSY: session ${id} owns a runtime writer`);}
 withOfflineSession<T>(id:string,action:()=>Promise<T>):Promise<T>{return this.options.withOfflineSession(id,async()=>{this.cold(id);return action();});}
 async captureSession(id:string):Promise<DshSessionArtifactCapture>{
  const before=await this.options.persistence.stat(id);if(!before)return {exists:false};
  const handle=await this.options.persistence.open(id,"read");
  try{if(handle.id!==id||handle.header.id!==id||handle.header.version!==3||handle.access!=="read")throw new TypeError("V3 read handle identity/access mismatch");
   const events=this.options.validateStoredEvents(handle.header,structuredClone([...(await handle.read()).events]));events.forEach((e,i)=>{if(e.seq!==i)throw new TypeError("V3 stored prefix is not contiguous");});
   const after=await this.options.persistence.stat(id);if(!after||!Object.is(before.revision,after.revision))throw new Error("DSH_BUSY: session changed during read");
   const artifact=canonicalJson({header:handle.header,events,inheritedEventCount:handle.inheritedEventCount} as never);
   // Stable content identity is used across gateway invocations; opaque stat tokens remain local to this read.
   return {exists:true,header:structuredClone(handle.header),events:structuredClone(events),inheritedEventCount:handle.inheritedEventCount,artifact:Buffer.from(artifact).toString("base64"),revision:`sha256:${createHash("sha256").update(artifact).digest("hex")}`};
  }finally{await handle.close();}
 }
 async createSession(header:DshNativeSessionHeader):Promise<void>{await this.createSessionWithEvents(header,[],0);}
 async createSessionWithEvents(header:DshNativeSessionHeader,events:readonly DshNativeEvent[],inheritedEventCount:number):Promise<void>{
  this.cold(header.id);if(header.version!==3)throw new TypeError("V3 header required");const valid=this.options.validateStoredEvents(header,structuredClone([...events]));
  const handle=await this.options.persistence.create(header,{inheritedEventCount});
  try{this.cold(header.id);if(handle.access!=="write"||handle.id!==header.id)throw new TypeError("V3 write handle mismatch");if(valid.length)await handle.append(valid);await handle.flush();}finally{await handle.close();}
 }
 async appendEvents(id:string,events:readonly DshNativeEvent[]):Promise<void>{
  this.cold(id);const handle=await this.options.persistence.open(id,"write");
  try{this.cold(id);if(handle.access!=="write"||handle.id!==id)throw new TypeError("V3 write handle mismatch");const prefix=(await handle.read()).events;const valid=this.options.validateStoredEvents(handle.header,structuredClone([...prefix,...events]));valid.forEach((e,i)=>{if(e.seq!==i)throw new TypeError("V3 append is not contiguous");});await handle.append(valid.slice(prefix.length));await handle.flush();}finally{await handle.close();}
 }
 async restoreSession(snapshot:DshSessionArtifactSnapshot):Promise<void>{this.cold(snapshot.sessionId);await this.options.restoreOfflineSession(snapshot);const actual=await this.captureSession(snapshot.sessionId);if(actual.exists!==snapshot.exists||actual.exists&&snapshot.exists&&actual.artifact!==snapshot.artifact)throw new Error("V3 offline restore did not reproduce the captured artifact");}
 captureWorkspace:DshCoreHost["captureWorkspace"]=(...args)=>this.options.metadata.captureWorkspace(...args);
 captureProjection:DshCoreHost["captureProjection"]=(...args)=>this.options.metadata.captureProjection(...args);
 captureRuntime:DshCoreHost["captureRuntime"]=(...args)=>this.options.metadata.captureRuntime(...args);
 attachWorkspace:DshCoreHost["attachWorkspace"]=(...args)=>this.options.metadata.attachWorkspace(...args);
 setArchive:DshCoreHost["setArchive"]=(...args)=>this.options.metadata.setArchive(...args);
 invalidateProjection:DshCoreHost["invalidateProjection"]=(...args)=>this.options.metadata.invalidateProjection(...args);
 reconcileRuntime:DshCoreHost["reconcileRuntime"]=(...args)=>this.options.metadata.reconcileRuntime(...args);
 restoreWorkspace:DshCoreHost["restoreWorkspace"]=(...args)=>this.options.metadata.restoreWorkspace(...args);
 restoreProjection:DshCoreHost["restoreProjection"]=(...args)=>this.options.metadata.restoreProjection(...args);
}
