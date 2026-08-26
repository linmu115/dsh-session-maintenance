import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { assertFixtureSandbox } from "./sandbox.js";

const FIXTURE_ROOT = resolve(import.meta.dirname, "../../../fixtures/codex/0.146.0");

export async function writeCodexFixtureHome(root: string): Promise<void> {
  assertFixtureSandbox(root);
  const existing = await readdir(root);
  if (existing.length > 0) {
    throw new Error(`Codex fixture destination must be empty: ${root}`);
  }

  const rollouts = join(root, "rollouts");
  await mkdir(rollouts);
  await writeFile(
    join(rollouts, "thread-fixture.jsonl"),
    await readFile(join(FIXTURE_ROOT, "rollout.jsonl")),
  );
  await writeFile(
    join(root, "session_index.jsonl"),
    `${JSON.stringify({
      id: "thread-fixture",
      title: "Fixture conversation",
      updated_at: "2026-08-26T00:00:02.000Z",
    })}\n`,
  );

  const database = new DatabaseSync(join(root, "state_5.sqlite"));
  try {
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec("PRAGMA page_size = 4096");
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        title TEXT NOT NULL,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived INTEGER NOT NULL
      ) STRICT
    `);
    database
      .prepare(
        `INSERT INTO threads
          (id, rollout_path, title, name, cwd, created_at, updated_at, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "thread-fixture",
        "rollouts/thread-fixture.jsonl",
        "Fixture conversation",
        "fixture",
        "C:\\fixture\\workspace",
        "2026-08-26T00:00:00.000Z",
        "2026-08-26T00:00:02.000Z",
        0,
      );
  } finally {
    database.close();
  }
}
