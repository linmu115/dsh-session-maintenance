import { createHash } from "node:crypto";
import { open, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  SessionMaintenanceError,
  transactionStepSchema,
  type JsonValue,
  type TransactionStep,
} from "@linmu/dsh-session-contracts";
import { canonicalJson } from "@linmu/dsh-session-domain";

import type { JournalEntryInput } from "./types.js";

type JsonObject = { readonly [key: string]: JsonValue };

function hashEntry(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function entryPayload(
  input: JournalEntryInput,
  sequence: number,
  previousHash: string | null,
): JsonObject {
  return {
    transactionId: input.transactionId,
    sequence,
    status: input.status,
    step: input.step,
    data: input.data,
    previousHash,
    at: input.at,
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

export class AppendOnlyJournal {
  readonly path: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  append(input: JournalEntryInput): Promise<TransactionStep> {
    const run = this.tail.then(() => this.appendNow(input));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async read(): Promise<readonly TransactionStep[]> {
    await this.tail;
    return this.readNow();
  }

  private async appendNow(input: JournalEntryInput): Promise<TransactionStep> {
    const existing = await this.readNow();
    const previous = existing.at(-1);
    const sequence = existing.length;
    const previousHash = previous?.entryHash ?? null;
    const payload = entryPayload(input, sequence, previousHash);
    const entry = transactionStepSchema.parse({
      ...payload,
      entryHash: hashEntry(payload),
    }) as TransactionStep;

    await mkdir(dirname(this.path), { recursive: true });
    const handle = await open(this.path, "a");
    try {
      await handle.writeFile(`${canonicalJson(entry as unknown as JsonValue)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      const directory = await open(dirname(this.path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { readonly code?: unknown }).code
          : undefined;
      if (!["EISDIR", "EINVAL", "EPERM", "ENOTSUP"].includes(String(code))) throw error;
    }
    return entry;
  }

  private async readNow(): Promise<readonly TransactionStep[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }

    const endsWithNewline = text.endsWith("\n");
    const rawLines = text.split("\n");
    if (endsWithNewline) rawLines.pop();
    const entries: TransactionStep[] = [];
    for (let index = 0; index < rawLines.length; index += 1) {
      const line = rawLines[index];
      if (line === undefined || line === "") continue;
      let parsed: TransactionStep;
      try {
        parsed = transactionStepSchema.parse(JSON.parse(line) as unknown) as TransactionStep;
      } catch (error) {
        const tornFinalLine = !endsWithNewline && index === rawLines.length - 1;
        if (tornFinalLine) break;
        throw new SessionMaintenanceError("OBJECT_CORRUPT", "Transaction journal is corrupt", {
          cause: error,
        });
      }
      const previous = entries.at(-1);
      const payload: JsonValue = {
        transactionId: parsed.transactionId,
        sequence: parsed.sequence,
        status: parsed.status,
        step: parsed.step,
        data: parsed.data,
        previousHash: parsed.previousHash,
        at: parsed.at,
      };
      if (
        parsed.sequence !== entries.length ||
        parsed.previousHash !== (previous?.entryHash ?? null) ||
        parsed.entryHash !== hashEntry(payload)
      ) {
        throw new SessionMaintenanceError("OBJECT_CORRUPT", "Transaction journal hash chain failed");
      }
      entries.push(parsed);
    }
    return entries;
  }
}
