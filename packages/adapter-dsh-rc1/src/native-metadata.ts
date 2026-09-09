import type { AdapterEvidencePort, AdapterEvidenceRef, CanonicalEventV1, JsonValue } from "@linmu/dsh-session-adapter-sdk";
import { digest } from "./materialize.js";

/** Exact, log-only RC1 controls and versioned plugin detail records. Never match arbitrary prefixes. */
export const NATIVE_METADATA_TYPES = new Set([
  "session/title", "session/title-llm-request", "model/selection",
  "permission/preset", "sandbox/mode", "approval/policy", "agent/inbox/spliced",
  "dsh-runtime/detail",
]);
function record(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Restore only verified RC1 log-only envelopes in a projection view; canonical history is immutable. */
export async function restoreRc1Metadata(
  events: readonly CanonicalEventV1[], evidence: Pick<AdapterEvidencePort, "readEvidence">,
): Promise<readonly CanonicalEventV1[]> {
  // Foreign/portable conversation history must not acquire native policy or model selection.
  if (events.some(e => e.extensions.portableFromRc1 === true || e.source.platform !== "dsh")) return events;
  const result: CanonicalEventV1[] = [];
  for (const event of events) {
    const type = event.extensions.dshEventType;
    if (event.kind !== "other" || typeof type !== "string" || !NATIVE_METADATA_TYPES.has(type)
      || !record(event.content) || event.content.sourceKind !== `dsh-rc1/${type}`
      || typeof event.content.evidenceRef !== "string" || event.rawPayload !== null) {
      result.push(event); continue;
    }
    const ref = event.content.evidenceRef;
    const stored = await evidence.readEvidence(ref as AdapterEvidenceRef, "dsh-rc1" as never);
    // Evidence may have been reclaimed. Keep the hidden record rather than invent state.
    if (stored === undefined) { result.push(event); continue; }
    const raw = stored.payload;
    if (stored.adapterId !== "dsh-rc1" || stored.nativeFormatId !== "dsh/0.1.2-rc.1/session-event-v1"
      || stored.sourceKind !== `dsh-rc1/${type}` || !record(raw) || raw.type !== type
      || !Number.isSafeInteger(raw.seq) || String(raw.seq) !== event.source.eventId
      || !Number.isSafeInteger(raw.time) || !record(raw.data) || raw.surfaceOp !== undefined) {
      throw new TypeError(`RC1 metadata evidence does not match its event: ${event.id}`);
    }
    const { heldOut: _heldOut, ...extensions } = event.extensions;
    result.push({ ...event, kind: "system-metadata", role: "system", content: raw.data,
      contentDigest: digest(raw.data), rawPayload: raw,
      extensions: { ...extensions, restoredMetadataEvidenceRef: ref } });
  }
  return result;
}
