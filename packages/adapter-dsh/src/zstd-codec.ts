import { zstdDecompressSync } from "node:zlib";

import type { JsonValue } from "@linmu/dsh-session-contracts";

export const ZSTD_FRAME_MAGIC = 0xfd2fb528;
export const MAX_DSH_COMPRESSED_BYTES = 64 * 1024 * 1024;
export const MAX_DSH_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
export const MAX_DSH_JSONL_LINES = 1_000_000;
export const MAX_DSH_LINE_BYTES = 8 * 1024 * 1024;
const MAX_ZSTD_BLOCK_BYTES = 128 * 1024;

export interface DshSessionHeader {
  readonly type: "session";
  readonly version: number;
  readonly id: string;
  readonly createdAt: number;
  readonly cwd: string;
  readonly delegationDepth: number;
}

interface DshSessionEventBase {
  readonly type: string;
  readonly data: Readonly<Record<string, JsonValue>>;
}

export interface DshStandardSessionEvent extends DshSessionEventBase {
  readonly seq: number;
  readonly time: number;
}

export interface DshPackedSessionEvent extends DshSessionEventBase {
  readonly seq0: number;
  readonly time0: number;
}

export type DshSessionEvent = DshStandardSessionEvent | DshPackedSessionEvent;

export function dshEventSequence(event: DshSessionEvent): number {
  return "seq" in event ? event.seq : event.seq0;
}

export function dshEventTime(event: DshSessionEvent): number {
  return "time" in event ? event.time : event.time0;
}

export interface DecodedHeaderFrame {
  readonly header: DshSessionHeader;
  readonly consumedBytes: number;
}

export interface DecodedDshArtifact {
  readonly frameCount: number;
  readonly header: DshSessionHeader;
  readonly events: readonly DshSessionEvent[];
}

interface FrameBoundary {
  readonly end: number;
  readonly declaredContentSize?: bigint;
}

function requireBytes(bytes: Buffer, offset: number, count: number, context: string): void {
  if (offset + count > bytes.length) {
    throw new Error(`Truncated Zstd ${context}`);
  }
}

function readUnsignedLittleEndian(bytes: Buffer, offset: number, size: number): bigint {
  requireBytes(bytes, offset, size, "frame header");
  let value = 0n;
  for (let index = 0; index < size; index += 1) {
    value |= BigInt(bytes[offset + index] ?? 0) << BigInt(index * 8);
  }
  return value;
}

function scanFrame(bytes: Buffer, offset: number): FrameBoundary {
  requireBytes(bytes, offset, 5, "magic/header");
  if (bytes.readUInt32LE(offset) !== ZSTD_FRAME_MAGIC) {
    throw new Error(`Invalid Zstd frame magic at offset ${offset}`);
  }
  let cursor = offset + 4;
  const descriptor = bytes[cursor] ?? 0;
  cursor += 1;
  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 0x20) !== 0;
  const unusedBit = (descriptor & 0x10) !== 0;
  const reservedBit = (descriptor & 0x08) !== 0;
  const checksum = (descriptor & 0x04) !== 0;
  const dictionaryFlag = descriptor & 0x03;
  if (unusedBit || reservedBit) {
    throw new Error("Zstd frame header uses reserved bits");
  }

  if (!singleSegment) {
    requireBytes(bytes, cursor, 1, "window descriptor");
    cursor += 1;
  }
  const dictionarySize = [0, 1, 2, 4][dictionaryFlag] ?? 0;
  requireBytes(bytes, cursor, dictionarySize, "dictionary ID");
  cursor += dictionarySize;
  const contentSizeBytes =
    contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8;
  let declaredContentSize: bigint | undefined;
  if (contentSizeBytes > 0) {
    declaredContentSize = readUnsignedLittleEndian(bytes, cursor, contentSizeBytes);
    if (contentSizeBytes === 2) {
      declaredContentSize += 256n;
    }
    if (declaredContentSize > BigInt(MAX_DSH_DECOMPRESSED_BYTES)) {
      throw new Error("Zstd frame declares oversized decompressed content");
    }
    cursor += contentSizeBytes;
  }
  let lastBlock = false;
  while (!lastBlock) {
    requireBytes(bytes, cursor, 3, "block header");
    const blockHeader =
      (bytes[cursor] ?? 0) | ((bytes[cursor + 1] ?? 0) << 8) | ((bytes[cursor + 2] ?? 0) << 16);
    cursor += 3;
    lastBlock = (blockHeader & 1) !== 0;
    const blockType = (blockHeader >>> 1) & 0x03;
    const blockSize = blockHeader >>> 3;
    if (blockType === 3) {
      throw new Error("Zstd block uses reserved block type");
    }
    if (blockSize > MAX_ZSTD_BLOCK_BYTES) {
      throw new Error(`Zstd block size exceeds ${MAX_ZSTD_BLOCK_BYTES} bytes`);
    }
    const encodedSize = blockType === 1 ? 1 : blockSize;
    requireBytes(bytes, cursor, encodedSize, "block payload");
    cursor += encodedSize;
  }

  if (checksum) {
    requireBytes(bytes, cursor, 4, "content checksum");
    cursor += 4;
  }
  return {
    end: cursor,
    ...(declaredContentSize === undefined ? {} : { declaredContentSize }),
  };
}

function decompressFrame(bytes: Buffer, start: number, boundary: FrameBoundary): Buffer {
  let output: Buffer;
  try {
    output = zstdDecompressSync(bytes.subarray(start, boundary.end), {
      maxOutputLength: MAX_DSH_DECOMPRESSED_BYTES,
    });
  } catch (error) {
    throw new Error("Zstd frame decompression or checksum verification failed", { cause: error });
  }
  if (boundary.declaredContentSize !== undefined && BigInt(output.byteLength) !== boundary.declaredContentSize) {
    throw new Error("Zstd frame content size does not match its header");
  }
  return output;
}

function parseHeader(bytes: Uint8Array): DshSessionHeader {
  const text = Buffer.from(bytes).toString("utf8").trim();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("DSH header frame is not valid JSON", { cause: error });
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { readonly type?: unknown }).type !== "session" ||
    typeof (value as { readonly version?: unknown }).version !== "number" ||
    typeof (value as { readonly id?: unknown }).id !== "string" ||
    typeof (value as { readonly createdAt?: unknown }).createdAt !== "number" ||
    typeof (value as { readonly cwd?: unknown }).cwd !== "string" ||
    typeof (value as { readonly delegationDepth?: unknown }).delegationDepth !== "number"
  ) {
    throw new Error("DSH header frame does not match the session contract");
  }
  return value as DshSessionHeader;
}

function parseEvents(frames: readonly Buffer[]): readonly DshSessionEvent[] {
  const text = Buffer.concat(frames).toString("utf8");
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length > MAX_DSH_JSONL_LINES) {
    throw new Error(`DSH artifact exceeds ${MAX_DSH_JSONL_LINES} JSONL lines`);
  }
  return lines.map((line, index) => {
    if (Buffer.byteLength(line, "utf8") > MAX_DSH_LINE_BYTES) {
      throw new Error(`DSH JSONL line ${index + 1} exceeds ${MAX_DSH_LINE_BYTES} bytes`);
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Malformed DSH JSONL at line ${index + 1}`, { cause: error });
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Malformed DSH event at line ${index + 1}`);
    }
    const event = value as {
      readonly seq?: unknown;
      readonly time?: unknown;
      readonly seq0?: unknown;
      readonly time0?: unknown;
      readonly type?: unknown;
      readonly data?: unknown;
    };
    const standard = typeof event.seq === "number" && typeof event.time === "number";
    const packed = typeof event.seq0 === "number" && typeof event.time0 === "number";
    if (
      typeof event.type !== "string" ||
      (!standard && !packed) ||
      typeof event.data !== "object" ||
      event.data === null ||
      Array.isArray(event.data)
    ) {
      throw new Error(`Malformed DSH event at line ${index + 1}`);
    }
    return value as DshSessionEvent;
  });
}

function asBuffer(bytes: Uint8Array): Buffer {
  if (bytes.byteLength > MAX_DSH_COMPRESSED_BYTES) {
    throw new Error(`DSH artifact exceeds ${MAX_DSH_COMPRESSED_BYTES} compressed bytes`);
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function decodeHeaderFrame(bytes: Uint8Array): DecodedHeaderFrame {
  const buffer = asBuffer(bytes);
  const boundary = scanFrame(buffer, 0);
  return { header: parseHeader(decompressFrame(buffer, 0, boundary)), consumedBytes: boundary.end };
}

export function decodeDshArtifact(bytes: Uint8Array): DecodedDshArtifact {
  const buffer = asBuffer(bytes);
  const outputs: Buffer[] = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const boundary = scanFrame(buffer, cursor);
    outputs.push(decompressFrame(buffer, cursor, boundary));
    cursor = boundary.end;
  }
  if (outputs.length < 2) {
    throw new Error("DSH artifact must contain a header frame and at least one event frame");
  }
  return {
    frameCount: outputs.length,
    header: parseHeader(outputs[0] ?? Buffer.alloc(0)),
    events: parseEvents(outputs.slice(1)),
  };
}
