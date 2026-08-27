import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppendOnlyJournal } from "../src/index.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "dsh-sm-journal-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("AppendOnlyJournal", () => {
  it("persists a monotonic hash chain and reopens it", async () => {
    const path = join(await root(), "journal.jsonl");
    const journal = new AppendOnlyJournal(path);
    const first = await journal.append({
      transactionId: "tx-a",
      status: "prepared",
      step: "transaction-created",
      at: "2026-08-27T00:00:00.000Z",
      data: {},
    });
    const second = await journal.append({
      transactionId: "tx-a",
      status: "backing-up",
      step: "backup-started",
      at: "2026-08-27T00:00:01.000Z",
      data: { required: 1 },
    });

    expect(first.sequence).toBe(0);
    expect(first.previousHash).toBeNull();
    expect(second.sequence).toBe(1);
    expect(second.previousHash).toBe(first.entryHash);
    expect(await new AppendOnlyJournal(path).read()).toEqual([first, second]);
  });

  it("ignores only a torn final line and rejects a changed committed line", async () => {
    const path = join(await root(), "journal.jsonl");
    const journal = new AppendOnlyJournal(path);
    await journal.append({
      transactionId: "tx-a",
      status: "prepared",
      step: "created",
      at: "2026-08-27T00:00:00.000Z",
      data: {},
    });
    await writeFile(path, `${await readFile(path, "utf8")}{\"sequence\":`, "utf8");
    expect(await journal.read()).toHaveLength(1);

    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace('"step":"created"', '"step":"changed"'), "utf8");
    await expect(journal.read()).rejects.toMatchObject({ code: "OBJECT_CORRUPT" });
  });
});
