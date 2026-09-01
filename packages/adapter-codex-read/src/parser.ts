import { createHash } from "node:crypto";

import { SessionMaintenanceError, type JsonValue } from "@linmu/dsh-session-contracts";

/** Hard safety ceiling; large valid rollouts are parsed incrementally below it. */
export const MAX_CODEX_ROLLOUT_BYTES = 512 * 1024 * 1024;
/**
 * Codex response items may legitimately contain multiple inline image payloads
 * on one JSONL line. Keep this bounded independently from the rollout ceiling,
 * while allowing the largest observed live envelope (9,805,006 bytes).
 */
export const MAX_CODEX_LINE_BYTES = 16 * 1024 * 1024;
export const MAX_CODEX_JSONL_LINES = 1_000_000;

export interface CodexEnvelope {
  readonly timestamp?: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, JsonValue>>;
}

export interface CodexThreadRow {
  readonly id: string;
  readonly rollout_path: string;
  readonly title: string;
  readonly name: string | null;
  readonly cwd: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly updated_at_ms: number | null;
  readonly archived: number;
  readonly project_id: string | null;
}

export interface CodexObservationPayload {
  readonly format: "codex-0.146.0";
  readonly thread: CodexThreadRow;
  readonly envelopes: readonly CodexEnvelope[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLine(line: Uint8Array, lineNumber: number): CodexEnvelope | undefined {
  const bytes = line.byteLength > 0 && line[line.byteLength - 1] === 0x0d
    ? line.subarray(0, line.byteLength - 1)
    : line;
  if (bytes.byteLength === 0) return undefined;
  if (bytes.byteLength > MAX_CODEX_LINE_BYTES) {
    throw new SessionMaintenanceError(
      "CONTENT_TOO_LARGE",
      `Codex JSONL line ${lineNumber} exceeds the line limit`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new Error(`Malformed JSONL at line ${lineNumber}`, { cause: error });
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string" || !isRecord(parsed.payload)) {
    throw new Error(`Malformed Codex envelope at line ${lineNumber}`);
  }
  return parsed as unknown as CodexEnvelope;
}

export function parseCodexJsonl(bytes: Uint8Array): readonly CodexEnvelope[] {
  if (bytes.byteLength > MAX_CODEX_ROLLOUT_BYTES) {
    throw new SessionMaintenanceError(
      "CONTENT_TOO_LARGE",
      `Codex rollout exceeds ${MAX_CODEX_ROLLOUT_BYTES} bytes`,
    );
  }
  const lines = Buffer.from(bytes).toString("utf8").split(/\n/u);
  if (lines.length > MAX_CODEX_JSONL_LINES) {
    throw new SessionMaintenanceError("CONTENT_TOO_LARGE", `Codex rollout exceeds ${MAX_CODEX_JSONL_LINES} lines`);
  }
  const envelopes: CodexEnvelope[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseLine(Buffer.from(lines[index] ?? "", "utf8"), index + 1);
    if (parsed !== undefined) envelopes.push(parsed);
  }

  return envelopes;
}

export interface ParsedCodexJsonlStream {
  readonly envelopes: readonly CodexEnvelope[];
  readonly bytesRead: number;
  readonly digest: string;
}

/** Parses arbitrarily chunked JSONL without materializing the whole rollout text. */
export async function parseCodexJsonlChunks(
  chunks: AsyncIterable<Uint8Array>,
): Promise<ParsedCodexJsonlStream> {
  const hash = createHash("sha256");
  const envelopes: CodexEnvelope[] = [];
  let carry = Buffer.alloc(0);
  let bytesRead = 0;
  let lineNumber = 0;
  for await (const value of chunks) {
    const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    bytesRead += chunk.byteLength;
    if (bytesRead > MAX_CODEX_ROLLOUT_BYTES) {
      throw new SessionMaintenanceError("CONTENT_TOO_LARGE", `Codex rollout exceeds ${MAX_CODEX_ROLLOUT_BYTES} bytes`);
    }
    hash.update(chunk);
    const buffer = carry.byteLength === 0 ? chunk : Buffer.concat([carry, chunk]);
    let start = 0;
    for (;;) {
      const newline = buffer.indexOf(0x0a, start);
      if (newline < 0) break;
      lineNumber += 1;
      if (lineNumber > MAX_CODEX_JSONL_LINES) {
        throw new SessionMaintenanceError("CONTENT_TOO_LARGE", `Codex rollout exceeds ${MAX_CODEX_JSONL_LINES} lines`);
      }
      const parsed = parseLine(buffer.subarray(start, newline), lineNumber);
      if (parsed !== undefined) envelopes.push(parsed);
      start = newline + 1;
    }
    carry = Buffer.from(buffer.subarray(start));
    if (carry.byteLength > MAX_CODEX_LINE_BYTES) {
      throw new SessionMaintenanceError("CONTENT_TOO_LARGE", `Codex JSONL line ${lineNumber + 1} exceeds the line limit`);
    }
  }
  if (carry.byteLength > 0) {
    lineNumber += 1;
    if (lineNumber > MAX_CODEX_JSONL_LINES) {
      throw new SessionMaintenanceError("CONTENT_TOO_LARGE", `Codex rollout exceeds ${MAX_CODEX_JSONL_LINES} lines`);
    }
    const parsed = parseLine(carry, lineNumber);
    if (parsed !== undefined) envelopes.push(parsed);
  }
  return { envelopes, bytesRead, digest: hash.digest("hex") };
}

export function isCodexObservationPayload(value: unknown): value is CodexObservationPayload {
  return (
    isRecord(value) &&
    value.format === "codex-0.146.0" &&
    isRecord(value.thread) &&
    Array.isArray(value.envelopes)
  );
}
