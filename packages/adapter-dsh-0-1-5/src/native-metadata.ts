import type { AdapterEvidencePort, AdapterEvidenceRef, CanonicalEventV1 } from "@linmu/dsh-session-adapter-sdk";
import { record, digest } from "./common.js";
import { currentManifest, currentFormatId, currentDialect } from "./dialect.js";
import { assertInformational } from "./references-remap.js";
import { validateV3Events } from "./official.js";
export function ownsV3CanonicalEvent(event:CanonicalEventV1):boolean {return event.extensions.adapterId===currentManifest().id||event.id.startsWith(`${currentManifest().id}:`)||Boolean(currentDialect()?.legacyOwners?.some(owner=>event.extensions.adapterId===owner.adapterId&&event.extensions.nativeFormatId===owner.formatId));}
export async function restoreV3Metadata(events:readonly CanonicalEventV1[],evidence:Pick<AdapterEvidencePort,"readEvidence">):Promise<readonly CanonicalEventV1[]> {
 return Promise.all(events.map(async event=>{
  if(!ownsV3CanonicalEvent(event)||event.rawPayload!==null||event.kind!=="other")return event;
  const content=record(event.content), ref=content.evidenceRef;if(typeof ref!=="string")throw new TypeError("V3 information event has no evidence receipt");
  const legacy=currentDialect()?.legacyOwners?.find(owner=>event.extensions.adapterId===owner.adapterId&&event.extensions.nativeFormatId===owner.formatId);
  const ownerId=(legacy?.adapterId??currentManifest().id) as Parameters<typeof evidence.readEvidence>[1],formatId=legacy?.formatId??currentFormatId();
  const stored=await evidence.readEvidence(ref as AdapterEvidenceRef,ownerId);
  if(!stored||stored.adapterId!==ownerId||stored.nativeFormatId!==formatId||stored.sourceKind!==content.sourceKind)throw new TypeError("V3 source evidence is missing or has wrong owner/format");
  const raw=record(stored.payload);if(String(raw.seq)!==event.source.eventId||raw.type!==event.extensions.dshEventType)throw new TypeError("V3 evidence identity mismatch");
  assertInformational(raw as never);validateV3Events([raw as never]);
  return {...event,rawPayload:stored.payload,extensions:{...event.extensions,restoredMetadataEvidenceRef:ref}};
 }));
}
