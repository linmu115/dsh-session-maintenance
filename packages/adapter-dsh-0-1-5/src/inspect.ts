import type { AdapterVerificationResult, ProjectionInspection, ProjectionManifest, ProjectionReader } from "@linmu/dsh-session-adapter-sdk";
import { record, digest, count } from "./common.js";
import { validateV3 } from "./official.js";
import { catalogDigest } from "./materialize.js";
export async function inspectV3(reader:ProjectionReader):Promise<ProjectionInspection> {
 const ids=[...await reader.listNativeSessionIds()].sort(),sessionDigests:Record<string,string>={},workspaces:string[]=[];
 const workspaceReader=reader as ProjectionReader & {listNativeWorkspaceIds?:()=>Promise<readonly string[]>};
 for(const id of ids){const value=await reader.readSession(id),p=record(value),h=record(p.header);if(h.id!==id||!Array.isArray(p.events))throw new TypeError("V3 projection identity mismatch");validateV3({header:h as never,events:p.events as never,inheritedEventCount:count(p.inheritedEventCount)});sessionDigests[id]=digest(value);if(typeof p.workspaceId==="string")workspaces.push(p.workspaceId);}
 const workspaceIds=workspaceReader.listNativeWorkspaceIds?await workspaceReader.listNativeWorkspaceIds():workspaces;
 return {sessionCount:ids.length,workspaceCount:new Set(workspaceIds).size,catalogDigest:catalogDigest(sessionDigests,workspaceIds),sessionDigests,issues:[]};
}
export function verifyV3(expected:ProjectionManifest,actual:ProjectionInspection):AdapterVerificationResult {
 const ok=expected.sessionCount===actual.sessionCount&&expected.workspaceCount===actual.workspaceCount&&expected.catalogDigest===actual.catalogDigest&&digest(expected.sessionDigests)===digest(actual.sessionDigests);
 return {ok,status:ok?"verified":"failed",issues:ok?actual.issues:[{code:"V3_PROJECTION_DIGEST_MISMATCH",message:"V3 projection differs from its materialization receipt"},...actual.issues]};
}
