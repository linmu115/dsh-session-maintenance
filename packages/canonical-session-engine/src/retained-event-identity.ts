import type { CanonicalEventV1 } from "@linmu/dsh-session-contracts";

function sourceKey(event: CanonicalEventV1): string | undefined {
  const parts = [event.source.platform, event.source.instanceId, event.source.sessionId, event.source.eventId];
  if (parts.some((part) => typeof part !== "string" || part.trim().length === 0)) return undefined;
  return JSON.stringify(parts);
}

/** Keep identity separate from corrected content/topology. Never mutate an old version. */
export function retainCanonicalEventIdentities(
  previous: readonly CanonicalEventV1[],
  incoming: readonly CanonicalEventV1[],
): readonly CanonicalEventV1[] {
  const previousBySource = new Map<string, string>();
  for (const event of previous) {
    const key = sourceKey(event);
    if (key === undefined) continue;
    if (previousBySource.has(key)) throw new TypeError("Ambiguous retained canonical source identity in previous version");
    previousBySource.set(key, event.id);
  }
  const seenSources = new Set<string>();
  const ids = new Map<string, string>();
  for (const event of incoming) {
    if (ids.has(event.id)) throw new TypeError(`Duplicate incoming canonical event ID: ${event.id}`);
    const key = sourceKey(event);
    if (key !== undefined) {
      if (seenSources.has(key)) throw new TypeError("Ambiguous retained canonical source identity in incoming version");
      seenSources.add(key);
    }
    ids.set(event.id, key === undefined ? event.id : previousBySource.get(key) ?? event.id);
  }
  const targets = new Set<string>();
  return incoming.map((event) => {
    const id = ids.get(event.id)!;
    if (targets.has(id)) throw new TypeError(`Retained canonical event ID collides: ${id}`);
    targets.add(id);
    const parent = event.extensions.parentEventId;
    const parentId = typeof parent === "string" ? ids.get(parent) ?? parent : parent;
    return {
      ...event,
      id,
      extensions: parentId === parent ? event.extensions : { ...event.extensions, parentEventId: parentId! },
    };
  });
}
