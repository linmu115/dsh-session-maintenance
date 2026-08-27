import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TransactionBackupStore } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("TransactionBackupStore", () => {
  it("deduplicates backup bytes and verifies a complete manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-backup-"));
    roots.push(root);
    const store = new TransactionBackupStore(root);
    const first = await store.put("session-artifact", Buffer.from("same"), true);
    const second = await store.put("projection-cache", Buffer.from("same"), false);
    expect(second.objectId).toBe(first.objectId);

    const manifest = await store.finalize(
      "tx-a",
      [first, second],
      "2026-08-27T00:00:00.000Z",
    );
    await expect(store.verify(manifest)).resolves.toEqual(manifest);
  });

  it("rejects a missing or corrupt required backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-backup-corrupt-"));
    roots.push(root);
    const store = new TransactionBackupStore(root);
    const entry = await store.put("session-artifact", Buffer.from("before"), true);
    const manifest = await store.finalize("tx-a", [entry], "2026-08-27T00:00:00.000Z");
    await writeFile(store.pathFor(entry.objectId), Buffer.from("after"));
    await expect(store.verify(manifest)).rejects.toMatchObject({ code: "BACKUP_CORRUPT" });
  });
});
