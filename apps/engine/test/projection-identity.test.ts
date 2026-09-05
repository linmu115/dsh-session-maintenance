import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { SessionMaintenanceQueries } from "../src/session-maintenance-queries.js";

it("resolves by exact run/native identity, including same-title mirrors and branches, never an old run", () => {
  const db = new DatabaseSync(":memory:");
  const queries = new SessionMaintenanceQueries(db);
  try {
    db.exec(`
      CREATE TABLE projection_runs (id TEXT PRIMARY KEY, state TEXT);
      CREATE TABLE projection_sessions (run_id TEXT, native_session_id TEXT, logical_session_id TEXT);
      CREATE TABLE logical_sessions (id TEXT PRIMARY KEY, display_title TEXT, tombstoned_at TEXT, authority_scope TEXT);
      INSERT INTO projection_runs VALUES ('run-current','running'), ('run-closed','closed');
      INSERT INTO logical_sessions VALUES ('mirror','Same title',NULL,'codex'), ('derived','Same title',NULL,'maintenance');
      INSERT INTO projection_sessions VALUES ('run-current','native-mirror','mirror'), ('run-current','native-derived','derived'), ('run-closed','native-stale','mirror');
    `);
    expect(queries.resolveProjectionSessionIdentity("run-current", "native-mirror")).toEqual({ logicalSessionId: "mirror", title: "Same title", status: "active" });
    expect(queries.resolveProjectionSessionIdentity("run-current", "native-derived")?.logicalSessionId).toBe("derived");
    expect(queries.resolveProjectionSessionIdentity("run-current", "native-stale")).toBeUndefined();
    expect(queries.resolveProjectionSessionIdentity("run-closed", "native-stale")).toBeUndefined();
    db.exec("UPDATE logical_sessions SET tombstoned_at='2026-09-05' WHERE id='mirror'");
    expect(queries.resolveProjectionSessionIdentity("run-current", "native-mirror")?.status).toBe("deleted");
    expect(db.prepare("SELECT count(*) AS count FROM logical_sessions").get()?.count).toBe(2);
  } finally { db.close(); }
});
