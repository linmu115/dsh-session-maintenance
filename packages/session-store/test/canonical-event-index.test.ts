import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CanonicalSessionEngine } from "@linmu/dsh-canonical-session-engine";
import type { CanonicalEventV1, LogicalSessionId } from "@linmu/dsh-session-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { openMaintenanceDatabase, SqliteCanonicalSessionEngineStore, ZstdContentObjectStore } from "../src/index.js";

const roots: string[] = [];
const databases: ReturnType<typeof openMaintenanceDatabase>[] = [];
const logicalSessionId = "index-fixture" as LogicalSessionId;
const at = "2026-09-06T00:00:00.000Z";
function event(sequence: number): CanonicalEventV1 {
  return { schemaVersion: 1, id: `fixture-event-${sequence}`, logicalSessionId, sequence,
    kind: "user-message", role: "user", content: { text: `body ${sequence}` },
    source: { platform: "codex", instanceId: "fixture", sessionId: "native", eventId: String(sequence), cursor: String(sequence) },
    contentDigest: `sha256:fixture-${sequence}`, rawPayload: null, extensions: {} };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "dsh-sm11-index-fixture-"));
  roots.push(root);
  const database = openMaintenanceDatabase(join(root, "metadata.sqlite"));
  databases.push(database);
  const store = new SqliteCanonicalSessionEngineStore(database, new ZstdContentObjectStore(root));
  const engine = new CanonicalSessionEngine(store);
  database.exec(`CREATE TABLE test_index_changes (operation TEXT NOT NULL);
    CREATE TRIGGER test_index_insert AFTER INSERT ON canonical_events BEGIN INSERT INTO test_index_changes VALUES ('insert'); END;
    CREATE TRIGGER test_index_delete AFTER DELETE ON canonical_events BEGIN INSERT INTO test_index_changes VALUES ('delete'); END;`);
  const observe = (events: readonly CanonicalEventV1[]) => engine.observeCodex({ logicalSessionId,
    title: "Synthetic index fixture", tags: [], archivedAt: null, workspaceId: null, events, sourceCursor: null, observedAt: at });
  const rows = () => database.prepare("SELECT id, sequence, event_json FROM canonical_events ORDER BY sequence").all();
  const changes = () => database.prepare("SELECT operation, COUNT(*) AS count FROM test_index_changes GROUP BY operation ORDER BY operation").all();
  const resetChanges = () => database.exec("DELETE FROM test_index_changes");
  return { database, store, observe, rows, changes, resetChanges };
}
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("incremental canonical event index", () => {
  it("writes only new rows for a long append, and repeated observations write none", async () => {
    const f = await setup();
    const original = Array.from({ length: 200 }, (_, index) => event(index));
    const before = await f.observe(original);
    const prefix = f.rows();
    f.resetChanges();
    const appended = [...original, event(200), event(201)];
    await f.observe(appended);
    expect(f.changes()).toEqual([{ operation: "insert", count: 2 }]);
    expect(f.rows().slice(0, original.length)).toEqual(prefix);
    expect((await f.store.getVersion(before.versionId!))?.events).toEqual(original);
    f.resetChanges();
    expect((await f.observe(appended)).outcome).toBe("noop");
    expect(f.changes()).toEqual([]);
  });

  it("rebuilds for topology changes even when event identity and content digest are unchanged", async () => {
    const f = await setup();
    const original = [event(0), event(1)];
    const before = await f.observe(original);
    f.resetChanges();
    const corrected = [{ ...original[0]!, extensions: { "mcsf.conversationTopology.v1": {
      schemaVersion: 1, turnId: "corrected", turnOrdinal: 0, stepId: null, stepOrdinal: null, phase: "user", inference: "derived",
    } } }, original[1]!, event(2)];
    await f.observe(corrected);
    expect(f.changes()).toEqual([{ operation: "delete", count: 2 }, { operation: "insert", count: 3 }]);
    expect(JSON.parse(String(f.rows()[0]!.event_json)).extensions).toEqual(corrected[0]!.extensions);
    expect((await f.store.getVersion(before.versionId!))?.events).toEqual(original);
  });

  it("rebuilds for shorter histories and corrects changed sequence order", async () => {
    const f = await setup();
    const original = [event(0), event(1), event(2)];
    await f.observe(original);
    f.resetChanges();
    const reordered = [{ ...original[1]!, sequence: 0 }, { ...original[0]!, sequence: 1 }];
    await f.observe(reordered);
    expect(f.changes()).toEqual([{ operation: "delete", count: 3 }, { operation: "insert", count: 2 }]);
    expect(f.rows().map((row) => row.id)).toEqual(["fixture-event-1", "fixture-event-0"]);
  });

  it.each([false, true])("rolls back a failed insert together with version/head changes (rebuild=%s), then retries", async (rebuild) => {
    const f = await setup();
    const original = [event(0), event(1)];
    const before = await f.observe(original);
    const rows = f.rows();
    f.resetChanges();
    f.database.exec(`CREATE TRIGGER test_fail_index BEFORE INSERT ON canonical_events
      WHEN NEW.id = 'fixture-event-3' BEGIN SELECT RAISE(ABORT, 'synthetic index write interrupted'); END;`);
    const next = [...original, event(2), event(3)];
    if (rebuild) next[0] = { ...original[0]!, content: { text: "normalized" }, contentDigest: "sha256:normalized" };
    await expect(f.observe(next)).rejects.toThrow("synthetic index write interrupted");
    expect(f.rows()).toEqual(rows);
    expect(f.changes()).toEqual([]);
    expect((await f.store.getSession(logicalSessionId))?.headVersionId).toBe(before.versionId);
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM session_versions").get()).toEqual({ count: 1 });
    f.database.exec("DROP TRIGGER test_fail_index");
    const retried = await f.observe(next);
    expect((await f.store.getVersion(retried.versionId!))?.events).toEqual(next);
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM session_versions").get()).toEqual({ count: 2 });
  });

  it("rejects duplicate events without changing the current index", async () => {
    const f = await setup();
    await f.observe([event(0)]);
    const rows = f.rows();
    f.resetChanges();
    await expect(f.observe([event(0), { ...event(0), sequence: 1 }])).rejects.toThrow("Duplicate incoming canonical event ID");
    expect(f.rows()).toEqual(rows);
    expect(f.changes()).toEqual([]);
  });
});
