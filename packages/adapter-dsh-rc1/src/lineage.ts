import { isAbsolute } from "node:path";

import type { JsonValue, NativeSessionId } from "@linmu/dsh-session-adapter-sdk";

import { rc1SessionLogOffset, type Rc1SessionLogOffset } from "./native-types.js";

export type Rc1LogicalSessionHeader = Readonly<Record<string, JsonValue>> & {
  readonly version: 0;
  readonly id: NativeSessionId;
  readonly createdAt: number;
  readonly isSeeded: boolean;
};

function record(value: JsonValue, description: string): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object`);
  }
  return value as Readonly<Record<string, JsonValue>>;
}

/** Validate the public RC1 SessionHeader shape, never the physical JSONL row. */
export function parseRc1LogicalSessionHeader(
  value: JsonValue,
  expectedId: NativeSessionId,
  description: string,
): Rc1LogicalSessionHeader {
  const header = record(value, description);
  if (Object.hasOwn(header, "type") || Object.hasOwn(header, "seedLength")) {
    throw new TypeError(`${description} mixes physical persistence fields into the logical SessionHeader`);
  }
  if (header.version !== 0 || header.id !== expectedId) {
    throw new TypeError(`${description} identity is invalid`);
  }
  if (typeof header.createdAt !== "number" || !Number.isSafeInteger(header.createdAt)
    || header.createdAt < 0 || Object.is(header.createdAt, -0)) {
    throw new TypeError(`${description} createdAt is invalid`);
  }
  if (typeof header.isSeeded !== "boolean") throw new TypeError(`${description} isSeeded is invalid`);
  if (header.cwd !== undefined && (typeof header.cwd !== "string" || !isAbsolute(header.cwd))) {
    throw new TypeError(`${description} cwd must be an absolute path`);
  }
  if (header.parentSession !== undefined && typeof header.parentSession !== "string") {
    throw new TypeError(`${description} parentSession is invalid`);
  }
  if (header.origin !== undefined && header.origin !== "subagent") {
    throw new TypeError(`${description} origin is invalid`);
  }
  if (header.delegationDepth !== undefined
    && (typeof header.delegationDepth !== "number" || !Number.isSafeInteger(header.delegationDepth)
      || header.delegationDepth < 0 || Object.is(header.delegationDepth, -0))) {
    throw new TypeError(`${description} delegationDepth is invalid`);
  }
  if (header.agentPreset !== undefined && typeof header.agentPreset !== "string") {
    throw new TypeError(`${description} agentPreset is invalid`);
  }
  return header as Rc1LogicalSessionHeader;
}

/** RC1-only metadata carried opaquely through the shared Broker/lifecycle DTOs. */
export function parseRc1RegistrationMetadata(value: JsonValue | undefined): Rc1SessionLogOffset {
  if (value === undefined) throw new TypeError("Seeded RC1 registration requires inheritedEventCount metadata");
  const metadata = record(value, "RC1 registration metadata");
  if (Object.keys(metadata).length !== 1 || !Object.hasOwn(metadata, "inheritedEventCount")) {
    throw new TypeError("RC1 registration metadata must contain only inheritedEventCount");
  }
  if (typeof metadata.inheritedEventCount !== "number") {
    throw new TypeError("RC1 inheritedEventCount must be a number");
  }
  return rc1SessionLogOffset(metadata.inheritedEventCount);
}

export function validateRc1Lineage(
  header: Rc1LogicalSessionHeader,
  inheritedEventCount: Rc1SessionLogOffset,
): void {
  if (!header.isSeeded && inheritedEventCount !== 0) {
    throw new TypeError("Unseeded RC1 session inheritedEventCount must be zero");
  }
}

