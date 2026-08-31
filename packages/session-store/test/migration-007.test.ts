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
import { MIGRATION_001 } from "../src/schema.js";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const createdAt = "2026-08-31T00:00:00.000Z";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-sm-migration-007-"));
  roots.push(root);
  return root;
}

function createSyntheticV6Database(path: string): void {
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
  ].entries()) {
    database.exec(migration);
    database
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(index + 1, createdAt);
  }

  database
    .prepare(
      `INSERT INTO logical_sessions
        (id, display_title, canonical_version_id, sync_mode, archived, labels_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("legacy-session", "Legacy session", null, "paused", 0, "[]", createdAt);
  database
    .prepare(
      `INSERT INTO session_versions
        (id, logical_session_id, body_object, body_hash, metadata_hash, manifest_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "legacy-version",
      "legacy-session",
      "sha256:legacy-body-object",
      "sha256:legacy-body",
      "sha256:legacy-metadata",
      JSON.stringify({ preserved: "without-rewrite" }),
      createdAt,
    );
  database
    .prepare("UPDATE logical_sessions SET canonical_version_id = ? WHERE id = ?")
    .run("legacy-version", "legacy-session");
  database
    .prepare(
      `INSERT INTO native_mirrors
        (logical_session_id, state, codex_binding_id, dsh_binding_id, common_version_id,
         codex_version_id, dsh_version_id, last_transaction_id, pause_reason, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "legacy-session",
      "paused",
      null,
      null,
      null,
      null,
      null,
      null,
      "legacy-preserved",
      createdAt,
    );
  database.close();
}

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("migration 007 canonical session source", () => {
  it("upgrades a synthetic v6 database without rewriting legacy session data", async () => {
    const root = await temporaryRoot();
    const path = join(root, "metadata.sqlite");
    createSyntheticV6Database(path);

    const database = new DatabaseSync(path);
    databases.push(database);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("BEGIN IMMEDIATE");
    database.exec(MIGRATION_007);
    database
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(7, createdAt);
    database.exec("COMMIT");

    expect(
      database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
    ).toEqual({ version: 7 });
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN
             ('canonical_events', 'session_derivations', 'logical_workspaces',
              'workspace_memberships', 'session_aliases', 'session_tombstones')
           ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "canonical_events" },
      { name: "logical_workspaces" },
      { name: "session_aliases" },
      { name: "session_derivations" },
      { name: "session_tombstones" },
      { name: "workspace_memberships" },
    ]);
    expect(
      database.prepare("PRAGMA table_info(logical_sessions)").all().map((row) =>
        (row as { readonly name: string }).name
      ),
    ).toEqual(expect.arrayContaining([
      "authority_scope",
      "origin_kind",
      "head_version_id",
      "archived_at",
      "tombstoned_at",
      "updated_at",
    ]));
    expect(
      database
        .prepare(
          `SELECT authority_scope, origin_kind, head_version_id, archived_at,
                  tombstoned_at, updated_at
           FROM logical_sessions WHERE id = ?`,
        )
        .get("legacy-session"),
    ).toEqual({
      authority_scope: null,
      origin_kind: null,
      head_version_id: "legacy-version",
      archived_at: null,
      tombstoned_at: null,
      updated_at: createdAt,
    });
    expect(
      database
        .prepare("SELECT manifest_json FROM session_versions WHERE id = ?")
        .get("legacy-version"),
    ).toEqual({ manifest_json: JSON.stringify({ preserved: "without-rewrite" }) });
    expect(
      database
        .prepare("SELECT state, pause_reason FROM native_mirrors WHERE logical_session_id = ?")
        .get("legacy-session"),
    ).toEqual({ state: "paused", pause_reason: "legacy-preserved" });

  }, 15_000);
});
