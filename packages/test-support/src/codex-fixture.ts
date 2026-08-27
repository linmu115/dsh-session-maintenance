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
      thread_name: "Fixture conversation",
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
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        sandbox_policy TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        has_user_event INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        git_sha TEXT,
        git_branch TEXT,
        git_origin_url TEXT,
        cli_version TEXT NOT NULL DEFAULT '',
        first_user_message TEXT NOT NULL DEFAULT '',
        agent_nickname TEXT,
        agent_role TEXT,
        memory_mode TEXT NOT NULL DEFAULT 'enabled',
        model TEXT,
        reasoning_effort TEXT,
        agent_path TEXT,
        created_at_ms INTEGER,
        updated_at_ms INTEGER,
        thread_source TEXT,
        preview TEXT NOT NULL DEFAULT '',
        recency_at INTEGER NOT NULL DEFAULT 0,
        recency_at_ms INTEGER NOT NULL DEFAULT 0,
        history_mode TEXT NOT NULL DEFAULT 'legacy',
        name TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        thread_section_id TEXT,
        section_position INTEGER,
        section_entered_at_ms INTEGER,
        project_id TEXT
      )
    `);
    database
      .prepare(
        `INSERT INTO threads
          (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
           sandbox_policy, approval_mode, cli_version, first_user_message, created_at_ms,
           updated_at_ms, preview, recency_at, recency_at_ms, name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "thread-fixture",
        "rollouts/thread-fixture.jsonl",
        1787702400,
        1787702402,
        "vscode",
        "openai",
        "C:\\fixture\\workspace",
        "Fixture conversation",
        "workspace-write",
        "never",
        "0.146.0",
        "Fixture question",
        1787702400000,
        1787702402000,
        "Fixture conversation",
        1787702402,
        1787702402000,
        "fixture",
      );
  } finally {
    database.close();
  }
}
