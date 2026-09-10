import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import type {
  JsonValue,
  LogicalSessionId,
  NativeAppendOperation,
  NativeSessionId,
  OperationId,
  RunId,
  SessionVersionId,
} from "@linmu/dsh-session-adapter-sdk";
import { RUNTIME_MANAGED_PROJECT_DIRECTORY } from "@linmu/dsh-session-adapter-sdk";
import type { NativeSessionArtifact } from "@linmu/dsh-session-adapter-sdk";

import {
  parseRc1LogicalSessionHeader,
  parseRc1RegistrationMetadata,
  validateRc1Lineage,
} from "./lineage.js";
import { rc1SessionLogOffset, type Rc1SessionLogOffset } from "./native-types.js";

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_JSONL_LINES = 1_000_001;
const MAX_JSONL_LINE_BYTES = 8 * 1024 * 1024;
const ZSTD_MAGIC = 0xfd2fb528;
const DEFERRED_SESSION_PRELUDE_TYPES = new Set([
  "session/end-seed",
  "permission/preset",
  "sandbox/mode",
  "approval/policy",
]);

type JsonRecord = { readonly [key: string]: JsonValue };

export type Rc1RuntimeTailRecoveryErrorCode =
  | "RECOVERY_ROOT_INVALID"
  | "RECOVERY_LAYOUT_UNSUPPORTED"
  | "RECOVERY_FORMAT_UNSUPPORTED"
  | "RECOVERY_ARTIFACT_CORRUPT"
  | "RECOVERY_MAPPING_INVALID"
  | "RECOVERY_MAPPING_MISSING"
  | "RECOVERY_HEADER_MISMATCH"
  | "RECOVERY_SEQUENCE_GAP"
  | "RECOVERY_PREFIX_REWRITTEN";

export class Rc1RuntimeTailRecoveryError extends Error {
  readonly code: Rc1RuntimeTailRecoveryErrorCode;

  constructor(code: Rc1RuntimeTailRecoveryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "Rc1RuntimeTailRecoveryError";
    this.code = code;
  }
}

/**
 * Durable Maintenance watermark for one Rc1 native session.
 *
 * `committedEvents` is deliberately required instead of trusting only the
 * numeric revision: recovery must prove that the disk prefix is byte-format
 * independent but JSON-value identical before it may append the missing tail.
 */
export interface Rc1CommittedRuntimeSession {
  readonly nativeSessionId: NativeSessionId;
  readonly logicalSessionId: LogicalSessionId;
  readonly baseVersionId: SessionVersionId | null;
  readonly nativeRevision: number;
  readonly header: JsonValue;
  readonly committedEvents: readonly JsonValue[];
  readonly adapterMetadata?: JsonValue;
  readonly instanceId?: string;
}

export interface Rc1RuntimeTailRecoveryInput {
  readonly runId: RunId;
  /** A Broker-created, per-run root; arbitrary DSH homes are not accepted. */
  readonly persistenceRoot: string;
  readonly sessions: readonly Rc1CommittedRuntimeSession[];
  readonly observedAt: string;
  /** Records an unmapped, preparation-only Rc1 shell that is intentionally ignored. */
  readonly onIgnoredPreparationArtifact?: (nativeSessionId: NativeSessionId) => void | Promise<void>;
}

interface RuntimeArtifact {
  readonly path: string;
  readonly compression: "none" | "zstd";
}

interface DecodedRuntimeArtifact {
  readonly header: JsonRecord;
  readonly events: readonly JsonValue[];
}

function fail(
  code: Rc1RuntimeTailRecoveryErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new Rc1RuntimeTailRecoveryError(code, message, cause === undefined ? undefined : { cause });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDeferredSessionPrelude(value: JsonValue): boolean {
  return isRecord(value)
    && typeof value.type === "string"
    && DEFERRED_SESSION_PRELUDE_TYPES.has(value.type);
}

/**
 * Rc1 writes these preparation rows while restoring a projected session,
 * before any user or assistant continuation exists. They must not create a
 * canonical branch when recovered from the projection WAL.
 */
export function isRc1PreparationOnlyAppend(operation: NativeAppendOperation): boolean {
  if (!isRecord(operation.payload)) return false;
  const events = operation.payload.events;
  return Array.isArray(events)
    && events.length > 0
    && events.every((event) => isDeferredSessionPrelude(event));
}

function exactJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(exactJson).join(",")}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${exactJson(record[key]!)}`).join(",")}}`;
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  return exactJson(left) === exactJson(right);
}

function encodeSegment(raw: string): string {
  if (raw.length === 0) fail("RECOVERY_HEADER_MISMATCH", "Rc1 session ID cannot be empty");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let encoded = "";
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const character = String.fromCharCode(code);
    encoded += character !== "~" && /^[A-Za-z0-9._-]$/.test(character)
      ? character
      : `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return encoded;
}

function projectKey(cwd: string): string {
  if (cwd.length === 0) fail("RECOVERY_HEADER_MISMATCH", "Rc1 SessionHeader.cwd cannot be empty");
  let readable = "";
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character === "/" || character === "\\" || character === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (character !== "~" && /^[A-Za-z0-9._-]$/.test(character)) {
      readable += character;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

export function expectedRc1ArtifactPath(root: string, header: JsonRecord, compression: RuntimeArtifact["compression"]): string {
  const cwd = header.cwd;
  const project = cwd === undefined ? "_no-cwd" : typeof cwd === "string" ? projectKey(cwd) : fail(
    "RECOVERY_HEADER_MISMATCH",
    "Rc1 SessionHeader.cwd must be a string when present",
  );
  const id = header.id;
  if (typeof id !== "string") fail("RECOVERY_HEADER_MISMATCH", "Rc1 SessionHeader.id must be a string");
  return resolve(root, project, encodeSegment(id), compression === "zstd" ? "session.jsonl.zstd" : "session.jsonl");
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLocaleLowerCase("en-US") === resolve(right).toLocaleLowerCase("en-US")
    : resolve(left) === resolve(right);
}

function parsePhysicalStorageHeader(value: unknown): JsonRecord {
  if (!isRecord(value)) fail("RECOVERY_ARTIFACT_CORRUPT", "Rc1 artifact header must be a JSON object");
  const allowedKeys = new Set([
    "type",
    "version",
    "id",
    "createdAt",
    "cwd",
    "parentSession",
    "seedLength",
    "origin",
    "delegationDepth",
    "agentPreset",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    fail("RECOVERY_FORMAT_UNSUPPORTED", "Rc1 SessionHeader contains fields outside the audited Rc1 format");
  }
  if (value.type !== "session") fail("RECOVERY_ARTIFACT_CORRUPT", "Rc1 artifact does not start with a session header");
  if (value.version !== 0) fail("RECOVERY_FORMAT_UNSUPPORTED", `Unsupported Rc1 session format version ${String(value.version)}`);
  if (typeof value.id !== "string" || value.id.length === 0
    || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0 || Object.is(value.createdAt, -0)
    || !Number.isSafeInteger(value.delegationDepth) || Number(value.delegationDepth) < 0 || Object.is(value.delegationDepth, -0)) {
    fail("RECOVERY_ARTIFACT_CORRUPT", "Rc1 artifact contains an invalid SessionHeader");
  }
  if ((value.cwd !== undefined && typeof value.cwd !== "string")
    || (value.parentSession !== undefined && typeof value.parentSession !== "string")
    || (value.seedLength !== undefined && (!Number.isSafeInteger(value.seedLength)
      || Number(value.seedLength) < 0 || Object.is(value.seedLength, -0)))
    || (value.origin !== undefined && value.origin !== "subagent")
    || (value.agentPreset !== undefined && typeof value.agentPreset !== "string")) {
    fail("RECOVERY_ARTIFACT_CORRUPT", "Rc1 artifact contains invalid optional SessionHeader fields");
  }
  return value;
}

function nativeHeader(storageHeader: JsonRecord): JsonRecord {
  const { type: _type, seedLength, ...header } = storageHeader;
  return { ...header, isSeeded: seedLength !== undefined };
}

function mappingInheritedEventCount(mapping: Rc1CommittedRuntimeSession): Rc1SessionLogOffset {
  const header = mapping.header as { readonly isSeeded: boolean };
  const inheritedEventCount = mapping.adapterMetadata === undefined && !header.isSeeded
    ? rc1SessionLogOffset(0)
    : parseRc1RegistrationMetadata(mapping.adapterMetadata);
  validateRc1Lineage(header as never, inheritedEventCount);
  return inheritedEventCount;
}

function hasExactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function packedRowFailure(tag: string, reason: string): never {
  return fail("RECOVERY_ARTIFACT_CORRUPT", `Malformed ${tag} storage row: ${reason}`);
}

function decodePackedRow(value: JsonRecord): readonly JsonValue[] | undefined {
  const tag = value.type;
  if (tag !== "text-chunks" && tag !== "reasoning-chunks" && tag !== "tool-call-chunks") return undefined;
  if (!hasExactKeys(value, ["type", "seq0", "time0", "data"])) packedRowFailure(tag, "invalid envelope");
  if (!Number.isSafeInteger(value.seq0) || Number(value.seq0) < 0 || !Number.isSafeInteger(value.time0)) {
    packedRowFailure(tag, "invalid seq0/time0");
  }
  if (!isRecord(value.data)) packedRowFailure(tag, "data must be an object");
  const data = value.data;
  const payloadKey = tag === "tool-call-chunks" ? "args" : "texts";
  const expectedKeys = tag === "tool-call-chunks"
    ? (Object.hasOwn(data, "name")
        ? ["turn", "step", "index", "id", "name", "dt", "args"]
        : ["turn", "step", "index", "id", "dt", "args"])
    : ["turn", "step", "index", "dt", "texts"];
  if (!hasExactKeys(data, expectedKeys)) packedRowFailure(tag, "invalid data fields");
  if (typeof data.turn !== "number" || typeof data.step !== "number" || typeof data.index !== "number") {
    packedRowFailure(tag, "turn/step/index must be numbers");
  }
  if (tag === "tool-call-chunks" && (typeof data.id !== "string"
    || (Object.hasOwn(data, "name") && typeof data.name !== "string"))) {
    packedRowFailure(tag, "tool call identity must be strings");
  }
  const payload = data[payloadKey];
  if (!Array.isArray(payload) || payload.length === 0 || payload.some((entry) => typeof entry !== "string")) {
    packedRowFailure(tag, `${payloadKey} must be a non-empty string array`);
  }
  if (!Array.isArray(data.dt) || data.dt.some((entry) => !Number.isSafeInteger(entry))
    || data.dt.length !== payload.length - 1) {
    packedRowFailure(tag, "dt does not match packed members");
  }
  const seq0 = Number(value.seq0);
  if (payload.length - 1 > Number.MAX_SAFE_INTEGER - seq0) packedRowFailure(tag, "member seq exceeds safe integers");
  const events: JsonValue[] = [];
  let time = Number(value.time0);
  for (let index = 0; index < payload.length; index += 1) {
    if (index > 0) time += Number(data.dt[index - 1]);
    if (!Number.isSafeInteger(time)) packedRowFailure(tag, "member time exceeds safe integers");
    const chunk = tag === "text-chunks"
      ? { type: "text-delta", index: data.index, text: payload[index]! }
      : tag === "reasoning-chunks"
        ? { type: "reasoning-delta", index: data.index, text: payload[index]! }
        : {
            type: "tool-call-delta",
            index: data.index,
            id: data.id!,
            ...(Object.hasOwn(data, "name") ? { name: data.name! } : {}),
            argumentsDelta: payload[index]!,
          };
    events.push({
      type: "assistant/chunk",
      seq: seq0 + index,
      time,
      data: { turn: data.turn, step: data.step, chunk },
    } as JsonValue);
  }
  return events;
}

function decodeSourceEventSeqs(value: JsonValue, eventSeq: number): readonly number[] {
  if (!Array.isArray(value)) fail("RECOVERY_ARTIFACT_CORRUPT", "sourceEventSeqs must be an array");
  const decoded: number[] = [];
  let hasRange = false;
  for (const entry of value) {
    if (typeof entry === "number") {
      if (!Number.isSafeInteger(entry) || entry < 0 || decoded.length >= eventSeq) {
        fail("RECOVERY_ARTIFACT_CORRUPT", "sourceEventSeqs contains an invalid sequence");
      }
      decoded.push(entry);
      continue;
    }
    if (!Array.isArray(entry) || entry.length !== 2) {
      fail("RECOVERY_ARTIFACT_CORRUPT", "sourceEventSeqs range must be [start, end]");
    }
    const [start, end] = entry;
    if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end) || start < 0 || end < start || end - start + 1 > eventSeq - decoded.length) {
      fail("RECOVERY_ARTIFACT_CORRUPT", "sourceEventSeqs contains an invalid range");
    }
    for (let seq = start; seq <= end; seq += 1) decoded.push(seq);
    hasRange = true;
  }
  if (hasRange && decoded.some((seq, index) => index > 0 && seq <= decoded[index - 1]!)) {
    fail("RECOVERY_ARTIFACT_CORRUPT", "sourceEventSeqs ranges must be strictly increasing");
  }
  return decoded;
}

function decodeStorageRecord(value: unknown): readonly JsonValue[] {
  if (!isRecord(value)) fail("RECOVERY_ARTIFACT_CORRUPT", "Rc1 storage record must be a JSON object");
  let expanded: JsonRecord = value;
  if (Object.hasOwn(value, "sourceEventSeqs")) {
    if (!Number.isSafeInteger(value.seq) || Number(value.seq) < 0) {
      fail("RECOVERY_ARTIFACT_CORRUPT", "Stored Rc1 event has invalid seq provenance");
    }
    expanded = { ...value, sourceEventSeqs: decodeSourceEventSeqs(value.sourceEventSeqs!, Number(value.seq)) };
  }
  return decodePackedRow(expanded) ?? [expanded];
}

function validateEvent(value: JsonValue, expectedSeq: number): void {
  if (!isRecord(value) || typeof value.type !== "string" || !Number.isSafeInteger(value.seq)
    || Number(value.seq) < 0 || Object.is(value.seq, -0) || !Number.isSafeInteger(value.time)
    || !Object.hasOwn(value, "data")) {
    fail("RECOVERY_ARTIFACT_CORRUPT", `Rc1 event ${expectedSeq} has an invalid envelope`);
  }
  if (value.seq !== expectedSeq) {
    fail("RECOVERY_SEQUENCE_GAP", `Rc1 event sequence gap: expected ${expectedSeq}, got ${String(value.seq)}`);
  }
}

function scanZstdFrames(buffer: Buffer): readonly { readonly start: number; readonly end: number }[] {
  const frames: { start: number; end: number }[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      fail("RECOVERY_ARTIFACT_CORRUPT", `Invalid Zstandard frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) fail("RECOVERY_ARTIFACT_CORRUPT", `Reserved Zstandard frame bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    if (!checksum) fail("RECOVERY_FORMAT_UNSUPPORTED", "Rc1 Zstandard frames must carry the audited checksum flag");
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    let torn = false;
    for (;;) {
      if (buffer.length - offset < 3) {
        torn = true;
        break;
      }
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) fail("RECOVERY_ARTIFACT_CORRUPT", `Reserved Zstandard block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) {
        torn = true;
        break;
      }
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (torn) break;
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

function decodeArtifactBytes(bytes: Buffer, compression: RuntimeArtifact["compression"]): Buffer {
  if (compression === "none") return bytes;
  const frames = scanZstdFrames(bytes);
  if (frames.length === 0) fail("RECOVERY_ARTIFACT_CORRUPT", "Rc1 Zstandard artifact has no complete header frame");
  const decoded: Buffer[] = [];
  let total = 0;
  for (const frame of frames) {
    let output: Buffer;
    try {
      output = zstdDecompressSync(bytes.subarray(frame.start, frame.end), {
        maxOutputLength: MAX_DECOMPRESSED_BYTES - total,
      });
    } catch (error) {
      fail("RECOVERY_ARTIFACT_CORRUPT", "Rc1 Zstandard frame failed checksum or decompression", error);
    }
    total += output.length;
    if (total > MAX_DECOMPRESSED_BYTES) fail("RECOVERY_ARTIFACT_CORRUPT", "Rc1 artifact exceeds decompression limit");
    if (output.length === 0 || output.at(-1) !== 10) {
      fail("RECOVERY_ARTIFACT_CORRUPT", "Rc1 Zstandard frame does not end at a JSONL record boundary");
    }
    if (decoded.length === 0 && output.indexOf(10) !== output.length - 1) {
      fail("RECOVERY_FORMAT_UNSUPPORTED", "Rc1 Zstandard header frame must contain exactly one SessionHeader row");
    }
    decoded.push(output);
  }
  return Buffer.concat(decoded, total);
}

function decodeArtifactJsonl(bytes: Buffer): DecodedRuntimeArtifact {
  const completeEnd = bytes.lastIndexOf(10);
  if (completeEnd < 0) fail("RECOVERY_ARTIFACT_CORRUPT", "Rc1 artifact has no complete header line");
  const complete = bytes.subarray(0, completeEnd + 1);
  const lines: Buffer[] = [];
  let start = 0;
  for (let newline = complete.indexOf(10, start); newline !== -1; newline = complete.indexOf(10, start)) {
    if (newline - start > MAX_JSONL_LINE_BYTES) fail("RECOVERY_ARTIFACT_CORRUPT", "Rc1 JSONL line exceeds size limit");
    lines.push(complete.subarray(start, newline));
    if (lines.length > MAX_JSONL_LINES) fail("RECOVERY_ARTIFACT_CORRUPT", "Rc1 JSONL artifact exceeds line limit");
    start = newline + 1;
  }
  const headerLine = lines[0];
  if (headerLine === undefined || headerLine.length === 0) fail("RECOVERY_ARTIFACT_CORRUPT", "Rc1 artifact is header-less");
  let parsedHeader: unknown;
  try {
    parsedHeader = JSON.parse(headerLine.toString("utf8"));
  } catch (error) {
    fail("RECOVERY_ARTIFACT_CORRUPT", "Rc1 session header is not valid JSON", error);
  }
  const header = parsePhysicalStorageHeader(parsedHeader);
  const events: JsonValue[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.length === 0) fail("RECOVERY_ARTIFACT_CORRUPT", `Rc1 artifact contains an empty event row at line ${index + 1}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString("utf8"));
    } catch (error) {
      fail("RECOVERY_ARTIFACT_CORRUPT", `Rc1 event row ${index} is not valid JSON`, error);
    }
    for (const event of decodeStorageRecord(parsed)) {
      validateEvent(event, events.length);
      events.push(event);
    }
  }
  return { header, events };
}

async function enumerateArtifacts(root: string): Promise<readonly RuntimeArtifact[]> {
  const artifacts: RuntimeArtifact[] = [];
  let rootCompression: RuntimeArtifact["compression"] | undefined;
  const projectEntries = await readdir(root, { withFileTypes: true });
  for (const projectEntry of projectEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) {
      fail("RECOVERY_LAYOUT_UNSUPPORTED", `Unexpected entry in Rc1 persistence root: ${projectEntry.name}`);
    }
    const project = join(root, projectEntry.name);
    const sessionEntries = await readdir(project, { withFileTypes: true });
    for (const sessionEntry of sessionEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!sessionEntry.isDirectory() || sessionEntry.isSymbolicLink()) {
        fail("RECOVERY_LAYOUT_UNSUPPORTED", `Unexpected Rc1 project entry: ${projectEntry.name}/${sessionEntry.name}`);
      }
      const directory = join(project, sessionEntry.name);
      const entries = await readdir(directory, { withFileTypes: true });
      if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
        fail("RECOVERY_LAYOUT_UNSUPPORTED", `Rc1 session directory contains a non-file entry: ${sessionEntry.name}`);
      }
      const zstd = entries.find((entry) => entry.name === "session.jsonl.zstd");
      const plain = entries.find((entry) => entry.name === "session.jsonl");
      if ((zstd === undefined) === (plain === undefined) || entries.length !== 1) {
        fail("RECOVERY_LAYOUT_UNSUPPORTED", `Rc1 session directory must contain exactly one supported artifact: ${sessionEntry.name}`);
      }
      const compression = zstd === undefined ? "none" : "zstd";
      if (rootCompression !== undefined && rootCompression !== compression) {
        fail("RECOVERY_LAYOUT_UNSUPPORTED", "Rc1 persistence root mixes plaintext and Zstandard artifacts");
      }
      rootCompression = compression;
      artifacts.push({
        path: join(directory, zstd === undefined ? "session.jsonl" : "session.jsonl.zstd"),
        compression,
      });
    }
  }
  return artifacts;
}

async function decodeArtifact(artifact: RuntimeArtifact): Promise<DecodedRuntimeArtifact> {
  const metadata = await stat(artifact.path);
  if (!metadata.isFile() || metadata.size > MAX_ARTIFACT_BYTES) {
    fail("RECOVERY_ARTIFACT_CORRUPT", `Rc1 artifact is not a bounded regular file: ${artifact.path}`);
  }
  const bytes = await readFile(artifact.path);
  return decodeArtifactJsonl(decodeArtifactBytes(bytes, artifact.compression));
}

function normalizeMapping(mapping: Rc1CommittedRuntimeSession): Rc1CommittedRuntimeSession {
  if (!Number.isSafeInteger(mapping.nativeRevision) || mapping.nativeRevision < 0
    || mapping.committedEvents.length !== mapping.nativeRevision) {
    fail("RECOVERY_MAPPING_INVALID", `Committed revision/prefix mismatch for ${mapping.nativeSessionId}`);
  }
  let header: JsonRecord;
  try {
    header = parseRc1LogicalSessionHeader(
      mapping.header,
      mapping.nativeSessionId,
      "RC1 committed logical SessionHeader",
    );
    mappingInheritedEventCount({ ...mapping, header });
  } catch (error) {
    fail("RECOVERY_MAPPING_INVALID", `Invalid Rc1 SessionHeader mapping for ${mapping.nativeSessionId}`, error);
  }
  for (let seq = 0; seq < mapping.committedEvents.length; seq += 1) validateEvent(mapping.committedEvents[seq]!, seq);
  return { ...mapping, header };
}

function isControlledManagedCwd(root: string, cwd: JsonValue | undefined): cwd is string {
  if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)) return false;
  const managedRoot = resolve(root, "..", RUNTIME_MANAGED_PROJECT_DIRECTORY);
  const child = relative(managedRoot, resolve(cwd));
  return child.length > 0 && !child.startsWith("..") && !isAbsolute(child);
}

function sameRuntimeHeader(root: string, runtime: JsonRecord, mapping: JsonValue): boolean {
  if (!isRecord(mapping)) return false;
  // The official RC1 JSONL writer persists header.delegationDepth ?? 0,
  // while a newly created public SessionHeader may omit this optional field.
  // Normalize only that documented storage default; nonzero depth and every
  // other identity/lineage field must still compare exactly.
  const persistedMapping: JsonRecord = { ...mapping, delegationDepth: mapping.delegationDepth ?? 0 };
  if (sameJson(runtime, persistedMapping)) return true;
  if (!isControlledManagedCwd(root, runtime.cwd)) return false;
  const { cwd: _runtimeCwd, ...runtimeRest } = runtime;
  const { cwd: _mappingCwd, ...mappingRest } = persistedMapping;
  return sameJson(runtimeRest, mappingRest);
}

/**
 * Recover only the durable, contiguous Rc1 tail that reached the official
 * per-run JSONL store but not the Runtime Broker WAL/canonical commit.
 *
 * The function is read-only. Any ambiguity is fatal: it never repairs a file,
 * skips a gap, accepts a rewritten prefix, or reads outside `persistenceRoot`.
 */
export async function recoverRc1RuntimeTail(
  input: Rc1RuntimeTailRecoveryInput,
): Promise<readonly NativeAppendOperation[]> {
  if (!isAbsolute(input.persistenceRoot)) fail("RECOVERY_ROOT_INVALID", "Rc1 recovery root must be absolute");
  const root = await realpath(resolve(input.persistenceRoot)).catch((error: unknown) => fail(
    "RECOVERY_ROOT_INVALID",
    "Rc1 recovery root does not exist",
    error,
  ));
  if (!(await stat(root)).isDirectory()) fail("RECOVERY_ROOT_INVALID", "Rc1 recovery root must be a directory");
  if (!Number.isFinite(Date.parse(input.observedAt))) fail("RECOVERY_MAPPING_INVALID", "Recovery observedAt must be an ISO timestamp");

  const mappings = new Map<string, Rc1CommittedRuntimeSession>();
  for (const rawMapping of input.sessions) {
    const mapping = normalizeMapping(rawMapping);
    if (mappings.has(mapping.nativeSessionId)) fail("RECOVERY_MAPPING_INVALID", `Duplicate native session mapping: ${mapping.nativeSessionId}`);
    mappings.set(mapping.nativeSessionId, mapping);
  }

  const seen = new Set<string>();
  const operations: NativeAppendOperation[] = [];
  for (const artifact of await enumerateArtifacts(root)) {
    const decoded = await decodeArtifact(artifact);
    const nativeId = decoded.header.id;
    if (typeof nativeId !== "string") fail("RECOVERY_ARTIFACT_CORRUPT", "Rc1 header ID is missing");
    if (seen.has(nativeId)) fail("RECOVERY_LAYOUT_UNSUPPORTED", `Duplicate Rc1 artifact for native session ${nativeId}`);
    seen.add(nativeId);
    if (!samePath(artifact.path, expectedRc1ArtifactPath(root, decoded.header, artifact.compression))) {
      fail("RECOVERY_HEADER_MISMATCH", `Rc1 artifact path does not match SessionHeader for ${nativeId}`);
    }
    const mapping = mappings.get(nativeId);
    if (mapping === undefined) {
      // Rc1 creates an unmapped composer shell and writes only permission,
      // sandbox and approval preparation before the user sends anything. It is
      // not a user session. Preserve fail-closed behavior as soon as any real
      // continuation event exists.
      if (decoded.events.every(isDeferredSessionPrelude)) {
        await input.onIgnoredPreparationArtifact?.(nativeId as NativeSessionId);
        continue;
      }
      fail("RECOVERY_MAPPING_MISSING", `No committed mapping exists for Rc1 session ${nativeId}`);
    }
    if (!sameRuntimeHeader(root, nativeHeader(decoded.header), mapping.header)) {
      fail("RECOVERY_HEADER_MISMATCH", `Rc1 SessionHeader was rewritten for ${nativeId}`);
    }
    const physicalInheritedEventCount = decoded.header.seedLength === undefined
      ? rc1SessionLogOffset(0)
      : rc1SessionLogOffset(Number(decoded.header.seedLength));
    if (physicalInheritedEventCount !== mappingInheritedEventCount(mapping)) {
      fail("RECOVERY_HEADER_MISMATCH", `Rc1 inherited event count was rewritten for ${nativeId}`);
    }
    if (decoded.events.length < mapping.nativeRevision) {
      fail("RECOVERY_PREFIX_REWRITTEN", `Rc1 artifact lost committed events for ${nativeId}`);
    }
    for (let seq = 0; seq < mapping.nativeRevision; seq += 1) {
      if (!sameJson(decoded.events[seq]!, mapping.committedEvents[seq]!)) {
        fail("RECOVERY_PREFIX_REWRITTEN", `Rc1 committed prefix differs at ${nativeId} seq ${seq}`);
      }
    }
    const tail = decoded.events.slice(mapping.nativeRevision);
    if (tail.length === 0) continue;
    // Rc1 restores a projected session by appending an internal seed marker
    // followed by permission/sandbox preparation. These events do not mean the
    // user continued the session and the live plugin deliberately defers them.
    // Crash recovery must make the same distinction or merely opening a Codex
    // mirror creates a false branch and can strand the run behind a revision
    // mismatch. When a real continuation follows, the complete contiguous tail
    // (including its prelude) is still recovered below.
    if (tail.every(isDeferredSessionPrelude)) continue;
    const lastSeq = decoded.events.length - 1;
    operations.push({
      runId: input.runId,
      operationId: `${input.runId}:tail-recovery:${nativeId}:${mapping.nativeRevision}-${lastSeq}` as OperationId,
      nativeSessionId: nativeId as NativeSessionId,
      nativeRevision: decoded.events.length,
      payload: {
        logicalSessionId: mapping.logicalSessionId,
        baseVersionId: mapping.baseVersionId,
        ...(mapping.instanceId === undefined ? {} : { instanceId: mapping.instanceId }),
        events: tail,
      },
      observedAt: input.observedAt,
    });
  }

  // Lazy Rc1 projection deliberately registers every canonical header but
  // materializes only hot or explicitly opened sessions. An absent artifact
  // therefore means there is no runtime tail to recover; the committed prefix
  // remains authoritative in Maintenance and is rebuilt on the next run.
  return operations;
}

/** Complete inventory for a retained native space; incomplete tails must be rebuilt after recovery. */
export async function inspectRc1NativeSpace(root: string): Promise<readonly NativeSessionArtifact[]> {
  const result: NativeSessionArtifact[] = [];
  const ids = new Set<string>();
  for (const artifact of await enumerateArtifacts(root)) {
    const bytes = await readFile(artifact.path);
    const decoded = await decodeArtifact(artifact);
    const id = String(decoded.header.id);
    if (ids.has(id) || !samePath(artifact.path, expectedRc1ArtifactPath(root, decoded.header, artifact.compression))) {
      fail("RECOVERY_LAYOUT_UNSUPPORTED", `Duplicate or misplaced Rc1 artifact: ${id}`);
    }
    ids.add(id);
    const complete = artifact.compression === "zstd"
      ? scanZstdFrames(bytes).at(-1)?.end === bytes.length
      : bytes.at(-1) === 10;
    result.push({ nativeSessionId: id as NativeSessionId, relativePath: relative(root, artifact.path),
      header: nativeHeader(decoded.header), events: decoded.events,
      inheritedEventCount: Number(decoded.header.seedLength ?? 0), complete });
  }
  return result;
}

export function isRc1PreparationEvents(events: readonly JsonValue[]): boolean {
  return events.every(isDeferredSessionPrelude);
}
