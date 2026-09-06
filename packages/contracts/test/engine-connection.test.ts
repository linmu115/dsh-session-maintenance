import { describe, expect, it } from "vitest";
import { engineConnectionDescriptorSchema } from "../src/index.js";

const legacy = { schemaVersion: 1, host: "127.0.0.1", port: 41780, token: "t".repeat(43) };
const ownerId = "477a57c1-3ed4-4e5d-8fcb-1d11e2652342";

describe("Engine connection descriptor", () => {
  it("keeps four-field v1 files compatible and accepts validated optional ownership fields", () => {
    for (const fields of [{}, { pid: 123 }, { ownerId }, { pid: 123, ownerId }]) {
      const descriptor = { ...legacy, ...fields };
      expect(engineConnectionDescriptorSchema.parse(descriptor)).toEqual(descriptor);
    }
  });

  it.each([
    { pid: 0 }, { pid: -1 }, { pid: 1.5 }, { pid: "123" }, { pid: null },
    { pid: Number.MAX_SAFE_INTEGER + 1 },
    { ownerId: "" }, { ownerId: "not-an-owner-uuid" }, { ownerId: null }, { ownerId: 123 },
    { host: "0.0.0.0" }, { port: 0 }, { port: 65_536 }, { token: "short" },
    { token: "t".repeat(257) }, { unrecognized: true },
  ])("rejects malformed connection fields %j", (fields) => {
    expect(engineConnectionDescriptorSchema.safeParse({ ...legacy, ...fields }).success).toBe(false);
  });
});
