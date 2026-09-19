import { currentFormatId } from "./dialect.js";
import { stat, mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { constants, zstdCompressSync } from "node:zlib";
import { RUNTIME_MANAGED_PROJECT_DIRECTORY, runtimeManagedProjectSegment, type NativeSessionCodec, type NativeSessionArtifact } from "@linmu/dsh-session-adapter-sdk";
import { record, count, digest } from "./common.js";
import { parseV3LogicalSessionHeader } from "./lineage.js";
import { expectedV3ArtifactPath } from "./layout.js";
import { validateV3, currentCatalog } from "./official.js";
import { inspectV3NativeSpace, decodeGeneration } from "./generation-reader.js";
import type { SessionFormatArtifact } from "@deepseek-ai/dsh-session-format";
import { preparePortableResources, validatePortableAttachments, portableResourceManifest, verifyPortableResources } from "./portable-resources.js";
export function isV3PreparationEvents(events:readonly unknown[]):boolean{return events.every(value=>{const e=record(value);return ["session/end-seed","permission/preset","sandbox/mode","approval/policy","model/selection","context/operation","context/operation-result","context/checkpoint","context/checkpoint-commit"].includes(String(e.type));});}
function frame(rows:readonly unknown[]):Buffer{return zstdCompressSync(Buffer.from(rows.map(r=>JSON.stringify(r)+"\n").join("")),{params:{[constants.ZSTD_c_checksumFlag]:1}});}
export function isV3PreparationArtifact(artifact: NativeSessionArtifact, registered: readonly NativeSessionArtifact[]): boolean {
 const inherited = artifact.inheritedEventCount;
 if (!Number.isSafeInteger(inherited) || inherited < 0 || inherited > artifact.events.length) return false;
 if (inherited === 0) return isV3PreparationEvents(artifact.events);
 const header = record(artifact.header);
 if (!artifact.complete || header.isSeeded !== true || typeof header.parentSession !== "string"
   || header.parentSession === artifact.nativeSessionId || !isV3PreparationEvents(artifact.events.slice(inherited))) return false;
 const parent = registered.find(item => item.nativeSessionId === header.parentSession);
 return !!parent && parent.complete && parent.events.length >= inherited
   && digest(parent.events.slice(0, inherited)) === digest(artifact.events.slice(0, inherited));
}
export const v3NativeSessionCodec:NativeSessionCodec={get formatId(){return currentFormatId();},
 prepareResources:preparePortableResources,
 resourceManifest:portableResourceManifest,verifyResources:verifyPortableResources,
 async describe(metadata,root){const payload=record(metadata),raw=record(payload.header),header=parseV3LogicalSessionHeader(raw,String(raw.id));let cwd: string|undefined;
 if(typeof header.cwd==="string"){try{if((await stat(header.cwd)).isDirectory())cwd=resolve(header.cwd);}catch(error){if(!["ENOENT","ENOTDIR","EPERM","EACCES"].includes((error as NodeJS.ErrnoException).code??""))throw error;}}
 if(cwd===undefined){cwd=join(dirname(root),RUNTIME_MANAGED_PROJECT_DIRECTORY,runtimeManagedProjectSegment(typeof payload.projectId==="string"?payload.projectId:null));await mkdir(cwd,{recursive:true});}
 const effective={...header,cwd};return {relativePath:relative(root,expectedV3ArtifactPath(root,effective,"zstd")),header:effective};},
 encode(value,description){validatePortableAttachments(value);const p=record(value),h=record(description.header),artifact=validateV3({header:parseV3LogicalSessionHeader(h,String(h.id)),inheritedEventCount:count(p.inheritedEventCount),events:p.events as unknown as SessionFormatArtifact["events"]});
 const buffers=[frame([currentCatalog().encodeCurrentHeader(artifact.header,artifact.inheritedEventCount)])];
 for(let i=0;i<artifact.events.length;i+=512)buffers.push(frame(artifact.events.slice(i,i+512).map(e=>currentCatalog().encodeCurrentEvent(e))));
 const bytes=Buffer.concat(buffers);const reread=decodeGeneration(bytes,"zstd",3);if(!reread.complete||digest(reread.artifact)!==digest(artifact))throw new Error("New native artifact is incomplete");return bytes;},
 verifyEncoded(bytes,value,description){const p=record(value),decoded=decodeGeneration(Buffer.from(bytes),"zstd",3);if(!decoded.complete||digest(decoded.artifact)!==digest({header:description.header,events:p.events,inheritedEventCount:p.inheritedEventCount}))throw new TypeError("Staged V3 artifact differs from intended projection");},
 inspect:inspectV3NativeSpace,isPreparationOnly:isV3PreparationEvents,isPreparationArtifact:isV3PreparationArtifact};
