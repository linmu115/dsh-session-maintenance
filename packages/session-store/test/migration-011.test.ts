import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { openMaintenanceDatabase } from "../src/database.js";

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
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
      CREATE TABLE logical_sessions (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE canonical_events (
        id TEXT PRIMARY KEY,
        logical_session_id TEXT NOT NULL REFERENCES logical_sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        kind TEXT NOT NULL CHECK (kind IN (
          'user-message', 'assistant-message', 'system-message', 'reasoning',
          'tool-call', 'tool-result', 'annotation', 'sticker', 'obsidian-reference',
          'attachment', 'system-metadata', 'opaque-unknown'
        )),
        content_digest TEXT NOT NULL,
        event_json TEXT NOT NULL,
        UNIQUE (logical_session_id, sequence)
      ) STRICT;
      CREATE INDEX canonical_events_session_sequence_idx
        ON canonical_events(logical_session_id, sequence);
    `);
    legacy.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(10, at);
    legacy.prepare("INSERT INTO logical_sessions (id) VALUES (?)").run("logical-1");
    legacy.prepare(`INSERT INTO canonical_events
      (id, logical_session_id, sequence, kind, content_digest, event_json)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run("legacy-opaque", "logical-1", 0, "opaque-unknown", "sha256:legacy", "{}");
    legacy.close();

    const database = openMaintenanceDatabase(path);
    databases.push(database);
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 11 });
    expect(database.prepare("SELECT id, kind FROM canonical_events ORDER BY sequence").all()).toEqual([
      { id: "legacy-opaque", kind: "opaque-unknown" },
    ]);
    database.prepare(`INSERT INTO canonical_events
      (id, logical_session_id, sequence, kind, content_digest, event_json)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run("mcsf-other", "logical-1", 1, "other", "sha256:other", "{}");
    expect(database.prepare("SELECT kind FROM canonical_events WHERE id = ?").get("mcsf-other"))
      .toEqual({ kind: "other" });
  });
});
