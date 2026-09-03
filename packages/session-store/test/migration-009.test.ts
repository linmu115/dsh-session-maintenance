import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { openMaintenanceDatabase } from "../src/database.js";
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

function createSyntheticV8Database(path: string): void {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
  for (const [index, migration] of [MIGRATION_001, MIGRATION_002, MIGRATION_003, MIGRATION_004, MIGRATION_005, MIGRATION_006, MIGRATION_007, MIGRATION_008].entries()) {
    database.exec(migration);
    database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(index + 1, at);
  }
  database.prepare(
    `INSERT INTO logical_sessions
      (id, display_title, canonical_version_id, sync_mode, archived, labels_json, created_at,
       authority_scope, origin_kind, head_version_id, archived_at, tombstoned_at, updated_at)
     VALUES (?, ?, NULL, 'paused', 0, '[]', ?, 'maintenance', 'maintenance-native', NULL, NULL, NULL, ?)`,
  ).run("legacy-session", "Legacy", at, at);
  database.prepare(
    `INSERT INTO logical_workspaces (id, parent_id, name, sort_key, deleted_at, created_at, updated_at)
     VALUES ('workspace-existing', NULL, 'Existing workspace', 'a', NULL, ?, ?)`,
  ).run(at, at);
  database.prepare(
    `INSERT INTO workspace_memberships (logical_session_id, workspace_id, display_order, pinned, archived, revision)
     VALUES ('legacy-session', 'workspace-existing', 0, 0, 0, 1)`,
  ).run();
  database.close();
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("migration 009 logical projects", () => {
  it("adds project, root and membership tables without guessing a project from workspace data", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-migration-009-"));
    roots.push(root);
    const path = join(root, "metadata.sqlite");
    createSyntheticV8Database(path);
    const database = openMaintenanceDatabase(path);
    databases.push(database);

    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 14 });
    expect(database.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name IN ('logical_projects', 'project_roots', 'project_memberships') ORDER BY name`,
    ).all()).toEqual([
      { name: "logical_projects" },
      { name: "project_memberships" },
      { name: "project_roots" },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM project_memberships").get()).toEqual({ count: 0 });
    expect(database.prepare(
      `SELECT wm.workspace_id FROM workspace_memberships wm WHERE wm.logical_session_id = 'legacy-session'`,
    ).get()).toEqual({ workspace_id: "workspace-existing" });
  }, 15_000);
});
