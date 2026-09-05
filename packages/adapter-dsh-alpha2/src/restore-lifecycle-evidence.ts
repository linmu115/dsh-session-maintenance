import type { AdapterEvidencePort, AdapterEvidenceRef, CanonicalEventV1, JsonValue } from "@linmu/dsh-session-adapter-sdk";
import { digest } from "./materialize.js";

const BOUNDARIES = new Set(["turn/start", "turn/end", "step/start", "step/end"]);
function record(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Explicit offline migration only. Never invoked by live projection/append. */
export async function restoreAlpha2LifecycleEvidence(
  events: readonly CanonicalEventV1[],
  evidence: Pick<AdapterEvidencePort, "readEvidence">,
): Promise<readonly CanonicalEventV1[]> {
  return Promise.all(events.map(async (event) => {
    const type = event.extensions.dshEventType;
    if (event.kind !== "other" || typeof type !== "string" || !BOUNDARIES.has(type)
      || event.source.platform !== "dsh" || !record(event.content)
      || event.content.sourceKind !== `dsh-alpha2/${type}`) return event;
    const ref = event.content.evidenceRef;
    if (event.rawPayload !== null || typeof ref !== "string") {
      throw new TypeError(`Alpha2 lifecycle evidence is missing or ambiguous: ${event.id}`);
    }
    const stored = await evidence.readEvidence(ref as AdapterEvidenceRef, "dsh-alpha2" as never);
    const raw = stored?.payload;
    if (stored?.adapterId !== "dsh-alpha2"
      || stored.nativeFormatId !== "dsh/0.1.2-alpha.2/session-event-v1"
      || stored.sourceKind !== `dsh-alpha2/${type}`
      || !record(raw) || raw.type !== type || raw.seq !== event.sequence
      || String(raw.seq) !== event.source.eventId || !Number.isSafeInteger(raw.time)
      || !record(raw.data) || !Number.isSafeInteger(raw.data.turn) || Number(raw.data.turn) < 1
      || (type.startsWith("step/") && (!Number.isSafeInteger(raw.data.step) || Number(raw.data.step) < 1))
      || (type === "turn/end" && (!record(raw.data.reason) || typeof raw.data.reason.kind !== "string"))
      || raw.surfaceOp !== undefined) {
      throw new TypeError(`Alpha2 lifecycle evidence does not match its event: ${event.id}`);
    }
    const { heldOut: _heldOut, ...extensions } = event.extensions;
    return {
      ...event,
      kind: "system-metadata" as const,
      role: "system" as const,
      content: raw.data,
      contentDigest: digest(raw.data),
      rawPayload: raw,
      extensions: { ...extensions, restoredLifecycleEvidenceRef: ref },
    };
  }));
}
