import { isAbsolute } from "node:path";
import { digest, record, count } from "./common.js";
import { inspectV3NativeSpace } from "./generation-reader.js";
import { isV3PreparationEvents } from "./native-session-codec.js";
import type { NativeAppendOperation, NativeSessionId, RunId, LogicalSessionId, SessionVersionId, JsonValue } from "@linmu/dsh-session-adapter-sdk";
export interface V3CommittedRuntimeSession {readonly nativeSessionId:NativeSessionId;readonly logicalSessionId:LogicalSessionId;readonly baseVersionId:SessionVersionId|null;readonly nativeRevision:number;readonly header:JsonValue;readonly committedEvents:readonly JsonValue[];readonly adapterMetadata?:JsonValue;readonly instanceId?:string;}
export async function recoverV3RuntimeTail(input:{readonly runId:RunId;readonly persistenceRoot:string;readonly sessions:readonly V3CommittedRuntimeSession[];readonly observedAt:string;readonly onIgnoredPreparationArtifact?:(id:NativeSessionId)=>void|Promise<void>}):Promise<readonly NativeAppendOperation[]> {
 if(!isAbsolute(input.persistenceRoot)||!Number.isFinite(Date.parse(input.observedAt)))throw new TypeError("Invalid recovery root or timestamp");
 const seen=new Set<string>();
 const mappings=new Map(input.sessions.map(s=>[s.nativeSessionId,s]));if(mappings.size!==input.sessions.length)throw new TypeError("Duplicate recovery mapping");const result:NativeAppendOperation[]=[];
 for(const artifact of await inspectV3NativeSpace(input.persistenceRoot)){seen.add(artifact.nativeSessionId);const mapping=mappings.get(artifact.nativeSessionId);if(!mapping){if(isV3PreparationEvents(artifact.events)){await input.onIgnoredPreparationArtifact?.(artifact.nativeSessionId);continue;}throw new TypeError(`Unmapped native history ${artifact.nativeSessionId}`);}
 const revision=count(mapping.nativeRevision,"native revision");if(mapping.committedEvents.length!==revision||artifact.events.length<revision)throw new TypeError("Recovery prefix length mismatch");
 if(digest(artifact.header)!==digest(mapping.header)||digest(artifact.events.slice(0,revision))!==digest(mapping.committedEvents))throw new TypeError("Recovery prefix/header rewritten");
 const inherited=mapping.adapterMetadata===undefined?0:count(record(mapping.adapterMetadata).inheritedEventCount);if(inherited!==artifact.inheritedEventCount)throw new TypeError("Recovery fork cut changed");
 const tail=artifact.events.slice(revision);if(!tail.length)continue;const operationId=`v3-recovery-${digest([input.runId,artifact.relativePath,artifact.header,revision,tail]).slice(7)}`;
 result.push({runId:input.runId,operationId:operationId as never,nativeSessionId:artifact.nativeSessionId,nativeRevision:artifact.events.length,observedAt:input.observedAt,payload:{logicalSessionId:mapping.logicalSessionId,baseVersionId:mapping.baseVersionId,...(mapping.instanceId?{instanceId:mapping.instanceId}:{}),header:artifact.header,inheritedEventCount:artifact.inheritedEventCount,events:tail}});}
 for(const mapping of input.sessions)if(mapping.nativeRevision>0&&!seen.has(mapping.nativeSessionId))throw new TypeError(`Committed native session is missing: ${mapping.nativeSessionId}`);
 return result;
}
export function isV3PreparationOnlyAppend(operation:NativeAppendOperation):boolean{const p=record(operation.payload);return Array.isArray(p.events)&&p.events.length>0&&isV3PreparationEvents(p.events);}
