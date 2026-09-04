import { describe, expect, it } from "vitest";

import {
  rc1SessionLogOffset,
  rc1SessionSeq,
  rc1SessionSeqCursor,
} from "../src/index.js";

describe("RC1 native numeric positions", () => {
  it("keeps event sequence and one-past-the-end log offset semantics distinct", () => {
    expect(rc1SessionSeq(0)).toBe(0);
    expect(rc1SessionLogOffset(1)).toBe(1);
    expect(rc1SessionSeqCursor(-1)).toBe(-1);
    expect(rc1SessionSeqCursor(0)).toBe(0);
  });

  it("rejects invalid sequence and offset values at the Adapter boundary", () => {
    expect(() => rc1SessionSeq(-1)).toThrow(/SessionSeq/u);
    expect(() => rc1SessionSeq(-0)).toThrow(/SessionSeq/u);
    expect(() => rc1SessionLogOffset(-1)).toThrow(/SessionLogOffset/u);
    expect(() => rc1SessionLogOffset(-0)).toThrow(/SessionLogOffset/u);
    expect(() => rc1SessionSeqCursor(-2)).toThrow(/SessionSeq/u);
    expect(() => rc1SessionLogOffset(Number.MAX_SAFE_INTEGER + 1)).toThrow(/SessionLogOffset/u);
  });
});
