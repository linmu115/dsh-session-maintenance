import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MAINTENANCE_SCHEMA_VERSION, MIGRATION_001 } from "./schema.js";
import { MIGRATION_002 } from "./migrations/002-job-events.js";
import { MIGRATION_003 } from "./migrations/003-transactions.js";
import { MIGRATION_004 } from "./migrations/004-continuations.js";

interface VersionRow {
  readonly version: number | null;
}

export function openMaintenanceDatabase(path: string): DatabaseSync {
  const absolutePath = resolve(path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const database = new DatabaseSync(absolutePath);

  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT
  `);

  const row = database
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as VersionRow | undefined;
  const currentVersion = row?.version ?? 0;
  if (currentVersion > MAINTENANCE_SCHEMA_VERSION) {
    database.close();
    throw new Error(
      `Database uses newer schema ${currentVersion}; supported version is ${MAINTENANCE_SCHEMA_VERSION}`,
    );
  }

  if (currentVersion < 1) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_001);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(1, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the migration failure.
      }
      database.close();
      throw error;
    }
  }

  if (currentVersion < 2) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_002);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(2, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the migration failure.
      }
      database.close();
      throw error;
    }
  }

  if (currentVersion < 3) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_003);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(3, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the migration failure.
      }
      database.close();
      throw error;
    }
  }

  if (currentVersion < 4) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_004);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(4, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the migration failure.
      }
      database.close();
      throw error;
    }
  }

  return database;
}
