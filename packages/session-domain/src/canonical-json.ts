import { createHash } from "node:crypto";

import type { JsonValue } from "@linmu/dsh-session-contracts";

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Canonical JSON only accepts finite numbers");
      }
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "undefined":
      throw new TypeError("Canonical JSON does not accept undefined");
    case "function":
      throw new TypeError("Canonical JSON does not accept function values");
    case "symbol":
      throw new TypeError("Canonical JSON does not accept symbol values");
    case "bigint":
      throw new TypeError("Canonical JSON does not accept bigint values");
    case "object":
      break;
    default:
      throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
  }

  if (ancestors.has(value)) {
    throw new TypeError("Canonical JSON does not accept cyclic values");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("Canonical JSON does not accept sparse arrays");
        }
        entries.push(serialize(value[index], ancestors));
      }
      return `[${entries.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON only accepts plain objects");
    }

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      throw new TypeError("Canonical JSON does not accept symbol keys");
    }

    const record = value as Record<string, unknown>;
    const entries = (ownKeys as string[])
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key], ancestors)}`);
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: JsonValue): string {
  return serialize(value, new Set<object>());
}

export function sha256Canonical(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
