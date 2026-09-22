import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { CanonicalEventV1, JsonValue } from '@linmu/dsh-session-contracts';
import { readJsonIfPresent, writeJsonAtomically } from './bindings.js';
const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const projectionSourceDigest = (events: readonly CanonicalEventV1[]) => createHash('sha256').update(JSON.stringify(stable(events))).digest('hex');
const pathFor = (root: string, endpoint: string, session: string) => join(root, 'endpoint-projection-receipts', createHash('sha256').update(JSON.stringify([endpoint, session])).digest('hex') + '.json');
export interface EndpointProjectionReceipt {
  schemaVersion: 1; sourceCount: number; sourceDigest: string; nativeEvents: JsonValue[];
  nativeToSource: number[]; sourceNativeCount: number;
}
export async function saveEndpointProjection(root: string, endpoint: string, session: string, events: readonly CanonicalEventV1[], payload: any): Promise<void> {
  const nativeEvents = payload.events as JsonValue[], mapped = payload.pluginProjection;
  await writeJsonAtomically(pathFor(root, endpoint, session), { schemaVersion: 1, sourceCount: events.length, sourceDigest: projectionSourceDigest(events), nativeEvents,
    nativeToSource: mapped?.nativeToSource ?? nativeEvents.map((_, index) => index), sourceNativeCount: mapped?.sourceNativeCount ?? nativeEvents.length });
}
export async function readEndpointProjection(root: string, endpoint: string, session: string): Promise<EndpointProjectionReceipt | undefined> {
  const value = await readJsonIfPresent(pathFor(root, endpoint, session)) as EndpointProjectionReceipt | undefined;
  if (value && (value.schemaVersion !== 1 || !Number.isSafeInteger(value.sourceCount) || value.sourceCount < 0 || typeof value.sourceDigest !== 'string'
    || !Array.isArray(value.nativeEvents) || !Array.isArray(value.nativeToSource) || value.nativeToSource.length !== value.nativeEvents.length
    || !Number.isSafeInteger(value.sourceNativeCount) || value.sourceNativeCount < 0
    || value.nativeToSource.some((n, index) => !Number.isSafeInteger(n) || n < 0 || n >= value.sourceNativeCount || index > 0 && n <= value.nativeToSource[index - 1]!)))
    throw new Error('SYNC_PROJECTION_RECEIPT_INVALID');
  return value;
}
