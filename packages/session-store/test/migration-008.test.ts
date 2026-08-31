import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { MIGRATION_002 } from "../src/migrations/002-job-events.js";
import { MIGRATION_003 } from "../src/migrations/003-transactions.js";
import { MIGRATION_004 } from "../src/migrations/004-continuations.js";
import { MIGRATION_005 } from "../src/migrations/005-native-mirrors.js";
import { MIGRATION_006 } from "../src/migrations/006-workspace-directory.js";
import { MIGRATION_007 } from "../src/migrations/007-canonical-session-source.js";
import { MIGRATION_008 } from "../src/migrations/008-projection-runtime.js";
import { MIGRATION_001 } from "../src/schema.js";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const at = "2026-08-31T00:00:00.000Z";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-sm-migration-008-"));
  roots.push(root);
  return root;
}

function createSyntheticV7Database(path: string): void {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  for (const [index, migration] of [
    MIGRATION_001,
    MIGRATION_002,
    MIGRATION_003,
    MIGRATION_004,
    MIGRATION_005,
    MIGRATION_006,
    MIGRATION_007,
  ].entries()) {
    database.exec(migration);
    database
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(index + 1, at);
  }
  database
    .prepare(
      `INSERT INTO logical_sessions
        (id, display_title, canonical_version_id, sync_mode, archived, labels_json, created_at,
         authority_scope, origin_kind, head_version_id, archived_at, tombstoned_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "canonical-before-v8",
      "Canonical before v8",
      null,
      "paused",
      0,
      "[]",
      at,
      "maintenance",
      "maintenance-native",
      null,
      null,
      null,
      at,
    );
  database.close();
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("migration 008 projection runtime", () => {
  it("upgrades v7 while retaining canonical-source rows", async () => {
    const root = await temporaryRoot();
    const path = join(root, "metadata.sqlite");
    createSyntheticV7Database(path);

    const database = new DatabaseSync(path);
    databases.push(database);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("BEGIN IMMEDIATE");
    database.exec(MIGRATION_008);
    database
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(8, at);
    database.exec("COMMIT");

    expect(
      database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
    ).toEqual({ version: 8 });
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN
             ('projection_runs', 'projection_sessions', 'projection_workspaces',
              'run_operations', 'run_status_events', 'adapter_registrations',
              'adapter_verification_runs')
           ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "adapter_registrations" },
      { name: "adapter_verification_runs" },
      { name: "projection_runs" },
      { name: "projection_sessions" },
      { name: "projection_workspaces" },
      { name: "run_operations" },
      { name: "run_status_events" },
    ]);
    expect(
      database
        .prepare("SELECT authority_scope, origin_kind FROM logical_sessions WHERE id = ?")
        .get("canonical-before-v8"),
    ).toEqual({ authority_scope: "maintenance", origin_kind: "maintenance-native" });
  }, 15_000);
});
