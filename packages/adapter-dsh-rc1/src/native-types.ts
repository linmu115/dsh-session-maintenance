/**
 * RC1 keeps event positions and log offsets numerically encoded, but they are
 * different protocol values: an event sequence must name an existing event,
 * while a log offset may point one past the final event.
 */
declare const rc1SessionSeqBrand: unique symbol;
declare const rc1SessionLogOffsetBrand: unique symbol;

export type Rc1SessionSeq = number & { readonly [rc1SessionSeqBrand]: "RC1 SessionSeq" };
export type Rc1SessionLogOffset = number & { readonly [rc1SessionLogOffsetBrand]: "RC1 SessionLogOffset" };
export type Rc1SessionSeqCursor = Rc1SessionSeq | -1;

export function rc1SessionSeq(value: number): Rc1SessionSeq {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError("RC1 SessionSeq must be a non-negative safe integer");
  }
  return value as Rc1SessionSeq;
}

export function rc1SessionLogOffset(value: number): Rc1SessionLogOffset {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError("RC1 SessionLogOffset must be a non-negative safe integer");
  }
  return value as Rc1SessionLogOffset;
}

export function rc1SessionSeqCursor(value: number): Rc1SessionSeqCursor {
  if (value === -1) return -1;
  return rc1SessionSeq(value);
}
