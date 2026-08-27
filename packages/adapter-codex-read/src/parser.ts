import { SessionMaintenanceError, type JsonValue } from "@linmu/dsh-session-contracts";

export const MAX_CODEX_ROLLOUT_BYTES = 64 * 1024 * 1024;
export const MAX_CODEX_LINE_BYTES = 8 * 1024 * 1024;

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
}

export interface CodexObservationPayload {
  readonly format: "codex-0.146.0";
  readonly thread: CodexThreadRow;
  readonly envelopes: readonly CodexEnvelope[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCodexJsonl(bytes: Uint8Array): readonly CodexEnvelope[] {
  if (bytes.byteLength > MAX_CODEX_ROLLOUT_BYTES) {
    throw new SessionMaintenanceError(
      "CONTENT_TOO_LARGE",
      `Codex rollout exceeds ${MAX_CODEX_ROLLOUT_BYTES} bytes`,
    );
  }
  const text = Buffer.from(bytes).toString("utf8");
  const lines = text.split(/\r?\n/u);
  const envelopes: CodexEnvelope[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.length === 0) {
      continue;
    }
    if (Buffer.byteLength(line, "utf8") > MAX_CODEX_LINE_BYTES) {
      throw new SessionMaintenanceError(
        "CONTENT_TOO_LARGE",
        `Codex JSONL line ${index + 1} exceeds the line limit`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Malformed JSONL at line ${index + 1}`, { cause: error });
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string" || !isRecord(parsed.payload)) {
      throw new Error(`Malformed Codex envelope at line ${index + 1}`);
    }
    envelopes.push(parsed as unknown as CodexEnvelope);
  }

  return envelopes;
}

export function isCodexObservationPayload(value: unknown): value is CodexObservationPayload {
  return (
    isRecord(value) &&
    value.format === "codex-0.146.0" &&
    isRecord(value.thread) &&
    Array.isArray(value.envelopes)
  );
}
