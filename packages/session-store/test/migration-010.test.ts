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
import { MIGRATION_009 } from "../src/migrations/009-logical-projects.js";
import { MIGRATION_001 } from "../src/schema.js";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const at = "2026-09-01T00:00:00.000Z";

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("migration 010 runtime status stages", () => {
  it("retains v9 status spans and accepts the public Runtime Broker stages", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-migration-010-"));
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
    ].entries()) {
      legacy.exec(migration);
      legacy.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(index + 1, at);
    }
    legacy.prepare(`INSERT INTO adapter_registrations
      (adapter_id, manifest_json, package_location, enabled, registered_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run("dsh-alpha2", "{}", "fixture://alpha2", 1, at, at);
    legacy.prepare(`INSERT INTO projection_runs
      (id, lease_id, branch_id, instance_id, profile_id, dsh_version, adapter_id,
       state, started_at, heartbeat_at, checkpoint_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("run-v9", "lease-v9", "main", "alpha2", "web", "0.1.2-alpha.2", "dsh-alpha2", "running", at, at, null);
    legacy.prepare(`INSERT INTO run_status_events
      (id, run_id, sequence, at, lease_id, profile_id, adapter_id, dsh_version,
       stage, state, logical_session_id, native_session_id, operation_id,
       parent_event_id, span_id, error_code, duration_ms, diagnostic_detail_ref,
       event_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("status-v9", "run-v9", 0, at, "lease-v9", "web", "dsh-alpha2", "0.1.2-alpha.2",
        "run.lease", "started", null, null, null, null, "span-v9", null, null, null, "{}");
    legacy.close();

    const database = openMaintenanceDatabase(path);
    databases.push(database);
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 13 });
    expect(database.prepare("SELECT id, stage FROM run_status_events ORDER BY sequence").all()).toEqual([
      { id: "status-v9", stage: "run.lease" },
    ]);
    database.prepare(`INSERT INTO run_status_events
      (id, run_id, sequence, at, lease_id, profile_id, adapter_id, dsh_version,
       stage, state, logical_session_id, native_session_id, operation_id,
       parent_event_id, span_id, error_code, duration_ms, diagnostic_detail_ref,
       event_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("status-runtime", "run-v9", 1, at, "lease-v9", "web", "dsh-alpha2", "0.1.2-alpha.2",
        "runtime.wal.durable", "succeeded", null, "native", "operation", "status-v9", "span-v9", null, 1, null, "{}");
    expect(database.prepare("SELECT stage, parent_event_id FROM run_status_events WHERE id = ?").get("status-runtime"))
      .toEqual({ stage: "runtime.wal.durable", parent_event_id: "status-v9" });
    database.prepare(`INSERT INTO run_status_events
      (id, run_id, sequence, at, lease_id, profile_id, adapter_id, dsh_version,
       stage, state, logical_session_id, native_session_id, operation_id,
       parent_event_id, span_id, error_code, duration_ms, diagnostic_detail_ref,
       event_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("status-evidence", "run-v9", 2, at, "lease-v9", "web", "dsh-alpha2", "0.1.2-alpha.2",
        "adapter.evidence", "succeeded", null, "native", "operation", null, "span-evidence", null, 1,
        "diag:adapter-evidence:1", "{}");
    expect(database.prepare("SELECT stage, diagnostic_detail_ref FROM run_status_events WHERE id = ?").get("status-evidence"))
      .toEqual({ stage: "adapter.evidence", diagnostic_detail_ref: "diag:adapter-evidence:1" });
  }, 15_000);
});
