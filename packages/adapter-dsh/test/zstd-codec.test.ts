import { describe, expect, it } from "vitest";

import { decodeDshArtifact, decodeHeaderFrame } from "../src/index.js";
import { encodeFixtureArtifact } from "../src/testing.js";

describe("DSH Zstd codec", () => {
  it("decodes bounded two-frame artifacts", () => {
    const artifact = encodeFixtureArtifact(
      {
        type: "session",
        version: 0,
        id: "dsh-session-1",
        createdAt: 1,
        cwd: "C:\\fixture\\workspace",
        delegationDepth: 0,
      },
      [
        {
          type: "user/message",
          seq: 0,
          time: 1,
          data: { content: [{ type: "text", text: "hello" }] },
        },
        {
          type: "text-chunks",
          seq0: 1,
          time0: 2,
          data: { turn: 1, step: 1, index: 0, dt: [0], texts: ["packed"] },
        },
      ],
    );

    const header = decodeHeaderFrame(artifact);
    const decoded = decodeDshArtifact(artifact);
    expect(header.header.version).toBe(0);
    expect(header.consumedBytes).toBeLessThan(artifact.byteLength);
    expect(decoded.frameCount).toBe(2);
    expect(decoded.header.version).toBe(0);
    expect(decoded.events).toHaveLength(2);
    expect(decoded.events[1]).toMatchObject({ type: "text-chunks", seq0: 1, time0: 2 });
  });

  it("rejects invalid magic, truncated frames and oversized blocks", () => {
    const valid = encodeFixtureArtifact(
      { type: "session", version: 0, id: "s", createdAt: 1, cwd: "C:\\fixture", delegationDepth: 0 },
      [{ type: "user/message", seq: 0, time: 1, data: { content: [] } }],
    );
    const invalidMagic = Buffer.from(valid);
    invalidMagic[0] = 0;
    expect(() => decodeDshArtifact(invalidMagic)).toThrow(/magic/iu);
    const reservedHeader = Buffer.from(valid);
    reservedHeader[4] = (reservedHeader[4] ?? 0) | 0x08;
    expect(() => decodeDshArtifact(reservedHeader)).toThrow(/reserved/iu);
    const invalidChecksum = Buffer.from(valid);
    invalidChecksum[invalidChecksum.length - 1] = (invalidChecksum.at(-1) ?? 0) ^ 0xff;
    expect(() => decodeDshArtifact(invalidChecksum)).toThrow(/checksum|decompression/iu);
    expect(() => decodeDshArtifact(valid.subarray(0, valid.length - 3))).toThrow(/truncated|checksum/iu);

    const oversized = Buffer.from([
      0x28, 0xb5, 0x2f, 0xfd,
      0x20,
      0x00,
      0x09, 0x00, 0x10,
    ]);
    expect(() => decodeDshArtifact(oversized)).toThrow(/block size/iu);
  });
});
