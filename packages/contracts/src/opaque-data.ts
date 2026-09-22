import type { CanonicalEventV1 } from './canonical.js';

/** Lossless mapping envelope. It is retained data, never a native instruction or rendered body. */
export interface OpaqueDataBundle<T extends CanonicalEventV1 = CanonicalEventV1> {
  readonly schemaVersion: 1;
  readonly kind: 'opaque-data-bundle';
  readonly logicalSessionId: T['logicalSessionId'];
  readonly events: readonly T[];
}

export function isOpaqueEvent(event: Pick<CanonicalEventV1, 'kind'>): boolean {
  return event.kind === 'opaque-unknown' || event.kind === 'other';
}

export function packOpaqueEvents<T extends CanonicalEventV1>(events: readonly T[]): OpaqueDataBundle<T> {
  const first = events[0];
  if (!first || events.some(event => !isOpaqueEvent(event) || event.logicalSessionId !== first.logicalSessionId))
    throw new Error('An opaque bundle must contain unrecognized events from one logical session');
  return { schemaVersion: 1, kind: 'opaque-data-bundle', logicalSessionId: first.logicalSessionId, events: [...events] };
}
