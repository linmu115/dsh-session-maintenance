import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  MIGRATION_001,
  MIGRATION_002,
  MIGRATION_003,
  MIGRATION_004,
  MIGRATION_005,
  MIGRATION_006,
  MIGRATION_007,
  MIGRATION_008,
  MIGRATION_009,
  MIGRATION_010,
  openMaintenanceDatabase,
} from "../src/index.js";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const at = "2026-09-03T00:00:00.000Z";

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("migration 011 MCSF other events", () => {
  it("retains legacy canonical events and accepts the new other kind", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-migration-011-"));
    roots.push(root);
    const path = join(root, "metadata.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA foreign_keys = ON");
    legacy.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    for (const [index, migration] of [
      MIGRATION_001,
      MIGRATION_002,
      MIGRATION_003,
      MIGRATION_004,
      MIGRATION_005,
      MIGRATION_006,
      MIGRATION_007,
      MIGRATION_008,
      MIGRATION_009,
      MIGRATION_010,
    ].entries()) {
      legacy.exec(migration);
      legacy.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(index + 1, at);
    }
    legacy.prepare(
      `INSERT INTO logical_sessions
        (id, display_title, canonical_version_id, sync_mode, archived, labels_json,
         authority_scope, origin_kind, head_version_id, archived_at, tombstoned_at,
         created_at, updated_at)
       VALUES (?, ?, NULL, 'paused', 0, '[]', 'maintenance', 'maintenance-native',
               NULL, NULL, NULL, ?, ?)`,
    ).run("logical-1", "Logical 1", at, at);
    legacy.prepare(`INSERT INTO canonical_events
      (id, logical_session_id, sequence, kind, content_digest, event_json)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run("legacy-opaque", "logical-1", 0, "opaque-unknown", "sha256:legacy", "{}");
    legacy.close();

    const database = openMaintenanceDatabase(path);
    databases.push(database);
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 13 });
    expect(database.prepare("SELECT id, kind FROM canonical_events ORDER BY sequence").all()).toEqual([
      { id: "legacy-opaque", kind: "opaque-unknown" },
    ]);
    database.prepare(`INSERT INTO canonical_events
      (id, logical_session_id, sequence, kind, content_digest, event_json)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run("mcsf-other", "logical-1", 1, "other", "sha256:other", "{}");
    expect(database.prepare("SELECT kind FROM canonical_events WHERE id = ?").get("mcsf-other"))
      .toEqual({ kind: "other" });
  }, 15_000);
});
