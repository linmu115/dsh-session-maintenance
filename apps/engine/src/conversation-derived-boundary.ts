import type { CanonicalEventV1, LogicalSessionId } from "@linmu/dsh-session-contracts";

function sourceIdentity(event: CanonicalEventV1, childId: LogicalSessionId): string {
  const { platform, instanceId, sessionId, eventId } = event.source;
  const fields = [platform, instanceId, sessionId, eventId];
  if (fields.some((field) => typeof field !== "string" || field.trim().length === 0)) {
    throw new Error(`Derived conversation fork boundary has an unidentified source event: ${childId}`);
  }
  return JSON.stringify(fields);
}

/**
 * A repaired parent may normalize content and omit log-only events, but every
 * retained source occurrence must belong to the immutable fork base in order.
 * Canonical identities, digests, and normalized cursors can all change during
 * repair, so none of them establishes the source boundary.
 */
export function assertDerivedParentForkBoundary(
  base: readonly CanonicalEventV1[],
  repairedParent: readonly CanonicalEventV1[],
  childId: LogicalSessionId,
): void {
  const basePositions = new Map<string, number>();
  for (const [index, event] of base.entries()) {
    const identity = sourceIdentity(event, childId);
    if (basePositions.has(identity)) {
      throw new Error(`Derived conversation fork boundary has duplicate base source events: ${childId}`);
    }
    basePositions.set(identity, index);
  }

  const retainedSources = new Set<string>();
  let previousPosition = -1;
  for (const event of repairedParent) {
    const identity = sourceIdentity(event, childId);
    if (retainedSources.has(identity)) {
      throw new Error(`Derived conversation fork boundary has duplicate repaired source events: ${childId}`);
    }
    retainedSources.add(identity);
    const position = basePositions.get(identity);
    if (position === undefined) {
      throw new Error(`Derived conversation fork boundary does not contain a repaired parent source event: ${childId}`);
    }
    if (position <= previousPosition) {
      throw new Error(`Derived conversation fork boundary reorders parent source events: ${childId}`);
    }
    previousPosition = position;
  }
}
