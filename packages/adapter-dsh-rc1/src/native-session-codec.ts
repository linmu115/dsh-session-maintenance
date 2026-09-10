import { mkdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { constants, zstdCompressSync } from "node:zlib";
import { RUNTIME_MANAGED_PROJECT_DIRECTORY, runtimeManagedProjectSegment } from "@linmu/dsh-session-adapter-sdk";
import type { JsonValue, NativeSessionCodec, NativeSessionId } from "@linmu/dsh-session-adapter-sdk";
import { parseRc1LogicalSessionHeader, validateRc1Lineage } from "./lineage.js";
import { rc1SessionLogOffset } from "./native-types.js";
import { expectedRc1ArtifactPath, inspectRc1NativeSpace, isRc1PreparationEvents } from "./runtime-tail-recovery.js";

function record(value: JsonValue): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid RC1 projection object");
  return value as Readonly<Record<string, JsonValue>>;
}

function frame(rows: readonly JsonValue[]): Buffer {
  return zstdCompressSync(Buffer.from(rows.map(row => `${JSON.stringify(row)}\n`).join("")), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  });
}

export const rc1NativeSessionCodec: NativeSessionCodec = {
  formatId: "dsh-rc1-jsonl-zstd-v1",
  async describe(metadata, root) {
    const payload = record(metadata);
    const original = record(payload.header ?? null);
    const header = parseRc1LogicalSessionHeader(original, original.id as NativeSessionId, "RC1 native projection header");
    let cwd: string | undefined;
    if (typeof header.cwd === "string") {
      try { if ((await stat(header.cwd)).isDirectory()) cwd = resolve(header.cwd); }
      catch (error) { if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
    if (cwd === undefined) {
      cwd = join(dirname(root), RUNTIME_MANAGED_PROJECT_DIRECTORY,
        runtimeManagedProjectSegment(typeof payload.projectId === "string" ? payload.projectId : null));
      await mkdir(cwd, { recursive: true });
    }
    const effective = { ...header, delegationDepth: header.delegationDepth ?? 0, cwd };
    return { relativePath: relative(root, expectedRc1ArtifactPath(root, effective, "zstd")), header: effective };
  },
  encode(value, description) {
    const payload = record(value);
    const h = record(description.header);
    const header = parseRc1LogicalSessionHeader(h, h.id as NativeSessionId, "RC1 encoded header");
    const inherited = rc1SessionLogOffset(Number(payload.inheritedEventCount ?? 0));
    validateRc1Lineage(header, inherited);
    if (!Array.isArray(payload.events) || inherited > payload.events.length) throw new TypeError("Invalid RC1 inherited prefix");
    const { isSeeded, ...physical } = header;
    const buffers = [frame([{ type: "session", ...physical, ...(isSeeded ? { seedLength: inherited } : {}) }])];
    const events = payload.events as readonly JsonValue[];
    events.forEach((value, seq) => {
      const event = record(value);
      if (event.seq !== seq || typeof event.type !== "string" || !Number.isSafeInteger(event.time) || !Object.hasOwn(event, "data")) {
        throw new TypeError(`Invalid contiguous RC1 event ${seq}`);
      }
    });
    for (let start = 0; start < events.length; start += 512) buffers.push(frame(events.slice(start, start + 512)));
    return Buffer.concat(buffers);
  },
  inspect: inspectRc1NativeSpace,
  isPreparationOnly: isRc1PreparationEvents,
};
