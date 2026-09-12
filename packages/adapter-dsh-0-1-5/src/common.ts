import { createHash } from "node:crypto";
import type { JsonValue } from "@linmu/dsh-session-adapter-sdk";
export type Obj = { readonly [key: string]: JsonValue };
export function isRecord(v: unknown): v is Obj { return v !== null && typeof v === "object" && !Array.isArray(v); }
export function record(v: unknown, name = "V3 object"): Obj { if (!isRecord(v)) throw new TypeError(`${name} must be an object`); return v; }
export function count(v: unknown, name = "count"): number { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || Object.is(v, -0)) throw new TypeError(`Invalid ${name}`); return v; }
function canonical(v: unknown): unknown { if (Array.isArray(v)) return v.map(canonical); if (isRecord(v)) return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])); return v; }
export function digest(v: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex")}`; }
export const HOST_VERSION = "0.1.5-rc.2";
export const FORMAT_ID = "dsh-0.1.5-v3-jsonl-zstd-v1";
