import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MAINTENANCE_SCHEMA_VERSION, MIGRATION_001 } from "./schema.js";
import { MIGRATION_002 } from "./migrations/002-job-events.js";
import { MIGRATION_003 } from "./migrations/003-transactions.js";
import { MIGRATION_004 } from "./migrations/004-continuations.js";
import { MIGRATION_005 } from "./migrations/005-native-mirrors.js";
import { MIGRATION_006 } from "./migrations/006-workspace-directory.js";
import { MIGRATION_007 } from "./migrations/007-canonical-session-source.js";
import { MIGRATION_008 } from "./migrations/008-projection-runtime.js";
import { MIGRATION_009 } from "./migrations/009-logical-projects.js";
import { MIGRATION_010 } from "./migrations/010-runtime-status-stages.js";
import { MIGRATION_011 } from "./migrations/011-mcsf-other-events.js";
import { MIGRATION_012 } from "./migrations/012-canonical-change-journal.js";
import { MIGRATION_013 } from "./migrations/013-adapter-evidence.js";
import { MIGRATION_014 } from "./migrations/014-native-reference-index.js";
import { MIGRATION_015 } from "./migrations/015-projection-delta-stage.js";
import { MIGRATION_016 } from "./migrations/016-projection-cache-retained-stage.js";
import { MIGRATION_017 } from "./migrations/017-version-metadata-snapshots.js";
import { reconstructCurrentVersionMetadata } from "./version-metadata.js";

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

  if (currentVersion < 5) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_005);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(5, new Date().toISOString());
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

  if (currentVersion < 6) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_006);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(6, new Date().toISOString());
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

  if (currentVersion < 7) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_007);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(7, new Date().toISOString());
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

  if (currentVersion < 8) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_008);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(8, new Date().toISOString());
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

  if (currentVersion < 9) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_009);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(9, new Date().toISOString());
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

  if (currentVersion < 10) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_010);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(10, new Date().toISOString());
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

  if (currentVersion < 11) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_011);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(11, new Date().toISOString());
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

  if (currentVersion < 12) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_012);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(12, new Date().toISOString());
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

  if (currentVersion < 13) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_013);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(13, new Date().toISOString());
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

  if (currentVersion < 14) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_014);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(14, new Date().toISOString());
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

  if (currentVersion < 15) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_015);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(15, new Date().toISOString());
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

  if (currentVersion < 16) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_016);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(16, new Date().toISOString());
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

  if (currentVersion < 17) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(MIGRATION_017);
      reconstructCurrentVersionMetadata(database);
      database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(17, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* preserve migration failure */ }
      database.close();
      throw error;
    }
  }

  return database;
}
