// Explicit, checkpointed repair of one Maintenance-owned historical head.
// Default is read-only preview. No Codex source/Home or projection writes.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { restoreAlpha2LifecycleEvidence } from "../packages/adapter-dsh-alpha2/dist/restore-lifecycle-evidence.js";
import { materializeRc1, inspectRc1 } from "../packages/adapter-dsh-rc1/dist/index.js";
import { buildCanonicalVersion } from "../packages/canonical-session-engine/dist/index.js";
import { SqliteCanonicalProjectionSource } from "../packages/projection-lifecycle/dist/index.js";
import { SqliteAdapterEvidenceStore, SqliteCanonicalSessionEngineStore, SqliteSessionRepository, ZstdContentObjectStore } from "../packages/session-store/dist/index.js";

const [rootArg, dbArg, logicalId, mode, expectedHead] = process.argv.slice(2);
assert(rootArg && dbArg && logicalId, "Usage: node repair-native-lifecycle.mjs <state-root> <database-file> <logical-id> [--apply <expected-head>]");
assert(mode === undefined || mode === "--apply", "Unknown repair mode");
assert(!mode || expectedHead, "Apply requires the reviewed expected head");
const root = resolve(rootArg);
const databasePath = resolve(root, dbArg);
assert(dirname(databasePath) === root && databasePath.endsWith(".sqlite"), "Database must be a named SQLite file directly within Maintenance state root");
const database = new DatabaseSync(databasePath, { readOnly: mode !== "--apply" });
const objects = new ZstdContentObjectStore(root);
const store = new SqliteCanonicalSessionEngineStore(database, objects);
const source = new SqliteCanonicalProjectionSource(database, objects);
const at = new Date().toISOString();
const run = { schemaVersion: 1, id: "run-native-repair-preview", leaseId: "lease-native-repair-preview", branchId: "main",
  instanceId: "repair-preview", profileId: "repair-preview", dshVersion: "0.1.2-rc.1", adapterId: "dsh-rc1",
  state: "preparing", startedAt: at, heartbeatAt: at, checkpointId: null };
try {
  const snapshot = await store.getSession(logicalId);
  assert(snapshot?.session.originKind === "maintenance-native" && !snapshot.session.tombstonedAt && !snapshot.tombstone,
    "Repair requires an active Maintenance-native session, not a Codex mirror or derivation");
  const old = await store.getVersion(snapshot.headVersionId);
  assert(old, "Missing historical head");
  if (mode) assert.equal(old.id, expectedHead, "Head changed since preview");
  const input = await source.loadSessions(run, [logicalId]);
  assert.equal(input.sessions.length, 1);
  const events = await restoreAlpha2LifecycleEvidence(old.events, new SqliteAdapterEvidenceStore(database, objects));
  const restored = events.filter((event, index) => event !== old.events[index]);
  let payload;
  await materializeRc1({ ...input, sessions: [{ ...input.sessions[0], events }] }, {
    writeWorkspace: async () => {}, writeSession: async (_id, value) => { payload = value; },
  });
  await inspectRc1({ listNativeSessionIds: async () => [payload.header.id], readSession: async () => payload });
  assert.deepEqual(events.map(event => event.id), old.events.map(event => event.id));
  console.log(JSON.stringify({ checkpoint: "native-repair.preview", logicalSessionId: logicalId, title: snapshot.session.title,
    oldHead: old.id, eventCount: events.length, restored: restored.map(event => ({ sequence: event.sequence, type: event.rawPayload.type })),
    projectionVerified: true }));
  if (mode === "--apply" && restored.length) {
    const active = database.prepare(`SELECT COUNT(*) n FROM projection_runs WHERE state IN
      ('preparing','running','draining','verifying','recovery-required','recovering','cleanup-pending')`).get().n;
    assert.equal(active, 0, "Stop all projection writers before repair");
    const backupDirectory = join(root, "backups");
    await mkdir(backupDirectory, { recursive: true });
    const backupPath = join(backupDirectory, `pre-native-lifecycle-${randomUUID()}.sqlite`);
    console.log(JSON.stringify({ checkpoint: "native-repair.backup", state: "started", backupPath }));
    await backup(database, backupPath, { rate: 4096 });
    console.log(JSON.stringify({ checkpoint: "native-repair.backup", state: "succeeded", backupPath }));
    const checkpointId = `checkpoint-native-lifecycle-${randomUUID()}`;
    const version = buildCanonicalVersion({ logicalSessionId: logicalId, parentVersionIds: [old.id], events,
      workspaceId: snapshot.workspaceId, title: snapshot.session.title, tags: snapshot.session.tags,
      archivedAt: snapshot.session.archivedAt, createdAt: at });
    await new SqliteSessionRepository(database, objects).saveCheckpoint({ id: checkpointId,
      name: "Native lifecycle repair before head change", description: "Restore verified Alpha2 boundary evidence only; retain original history.",
      refs: { [`session:${logicalId}`]: old.id }, backupTransactionIds: [], createdBy: "repair-native-lifecycle", createdAt: at });
    assert.equal(database.prepare("SELECT head_version_id FROM logical_sessions WHERE id=?").get(logicalId).head_version_id,
      old.id, "Head changed before commit");
    await store.commit({ kind: "dsh-append", operationId: null,
      session: { ...snapshot.session, headVersionId: version.id }, version,
      membership: null, derivation: null, projectionReceipt: null, tombstone: null, observation: null,
      receipt: { outcome: "advanced", operationId: null, logicalSessionId: logicalId, versionId: version.id, tombstoneState: null, committedAt: at },
    });
    assert.deepEqual((await store.getVersion(old.id)).events, old.events, "Original version changed");
    console.log(JSON.stringify({ checkpoint: "native-repair.applied", checkpointId, backupPath, newHead: version.id,
      preservedEventIds: events.length }));
  }
} finally { database.close(); }
