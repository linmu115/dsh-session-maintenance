import { constants as zlibConstants, zstdCompressSync } from "node:zlib";

import type { DshSessionEvent, DshSessionHeader } from "./zstd-codec.js";

function frame(bytes: Uint8Array): Buffer {
  return zstdCompressSync(bytes, {
    params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 },
  });
}

export function encodeFixtureArtifact(
  header: DshSessionHeader,
  events: readonly DshSessionEvent[],
): Buffer {
  const headerBytes = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
  const eventBytes = Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
  return Buffer.concat([frame(headerBytes), frame(eventBytes)]);
}
