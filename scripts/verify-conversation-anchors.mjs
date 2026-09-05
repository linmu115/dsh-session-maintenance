// Read-only candidate audit. One session at a time; no source/Home writes or model calls.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { materializeRc1, resolveRc1Reference } from "../packages/adapter-dsh-rc1/dist/index.js";
import { SqliteCanonicalProjectionSource } from "../packages/projection-lifecycle/dist/index.js";
import { SqliteCanonicalSessionEngineStore, ZstdContentObjectStore } from "../packages/session-store/dist/index.js";

const [stateRootArg, oldPathArg, candidatePathArg] = process.argv.slice(2);
if (!stateRootArg || !oldPathArg || !candidatePathArg) {
  throw new Error("Usage: node scripts/verify-conversation-anchors.mjs <state-root> <old-db> <candidate-db>");
}
const stateRoot = resolve(stateRootArg);
const oldDb = new DatabaseSync(resolve(oldPathArg), { readOnly: true });
const candidate = new DatabaseSync(resolve(candidatePathArg), { readOnly: true });
const objects = new ZstdContentObjectStore(stateRoot);
const oldStore = new SqliteCanonicalSessionEngineStore(oldDb, objects);
const newStore = new SqliteCanonicalSessionEngineStore(candidate, objects);
const projectionSource = new SqliteCanonicalProjectionSource(candidate, objects);
const run = { schemaVersion: 1, id: "run-anchor-readonly-audit", leaseId: "lease-audit", branchId: "main",
  instanceId: "rc1-audit", profileId: "audit", dshVersion: "0.1.2-rc.1", adapterId: "dsh-rc1", state: "preparing",
  startedAt: "2026-09-05T00:00:00.000Z", heartbeatAt: "2026-09-05T00:00:00.000Z", checkpointId: null };
function sourceKey(event) {
  const fields = [event.source.platform, event.source.instanceId, event.source.sessionId, event.source.eventId];
  return fields.every((value) => typeof value === "string" && value.length > 0) ? JSON.stringify(fields) : undefined;
}
function messageId(event) {
  const value = event.content?.message ?? event.content;
  return typeof value?.id === "string" && value.id.trim() ? value.id : event.id;
}
const counts = { sessions: 0, retainedIdentities: 0, checkedMessages: 0, checkedAliases: 0, resolverSamples: 0 };
try {
  const sessions = candidate.prepare(`SELECT id, head_version_id FROM logical_sessions
    WHERE origin_kind IN ('codex-mirror', 'codex-derived') AND tombstoned_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.logical_session_id = logical_sessions.id AND t.restored_at IS NULL)
    ORDER BY id`).all();
  for (const row of sessions) {
    const old = await oldStore.getSession(row.id);
    const oldHead = old?.headVersionId ? await oldStore.getVersion(old.headVersionId) : undefined;
    const fresh = await newStore.getVersion(row.head_version_id);
    assert(fresh, `Missing candidate head: ${row.id}`);
    const oldBySource = new Map((oldHead?.events ?? []).map((event) => [sourceKey(event), event]));
    for (const event of fresh.events) {
      const key = sourceKey(event);
      const previous = key === undefined ? undefined : oldBySource.get(key);
      if (previous) {
        assert.equal(event.id, previous.id, `Retained identity changed in ${row.id}: ${key}`);
        counts.retainedIdentities++;
      }
    }
    let payload;
    const input = await projectionSource.loadSessions(run, [row.id]);
    assert.equal(input.sessions.length, 1);
    await materializeRc1(input, { writeWorkspace: async () => {}, writeSession: async (_id, value) => { payload = value; } });
    assert(payload);
    const actualIds = new Set();
    for (const event of payload.events) {
      if (event.surfaceOp !== "append") continue;
      const id = event.type === "user/message" ? event.data?.id : event.data?.message?.id;
      if (typeof id !== "string") continue;
      assert(!actualIds.has(id), `Duplicate projected message in ${row.id}`);
      actualIds.add(id);
    }
    const aliases = payload.anchorAliases ?? {};
    for (const [alias, target] of Object.entries(aliases)) {
      assert(actualIds.has(target), `Alias has no message target in ${row.id}: ${alias}`);
      counts.checkedAliases++;
    }
    let sample;
    for (const event of fresh.events) {
      if (event.kind !== "user-message" && event.kind !== "assistant-message") continue;
      const anchor = messageId(event);
      assert(actualIds.has(aliases[anchor] ?? anchor), `Message anchor disappeared in ${row.id}: ${anchor}`);
      counts.checkedMessages++;
      sample = anchor;
    }
    if (sample) {
      const resolved = await resolveRc1Reference({ logicalSessionId: row.id, logicalAnchorId: sample,
        legacyNativeSessionId: payload.header.id }, run, { readSession: async () => payload, listNativeSessionIds: async () => [payload.header.id] });
      assert.equal(resolved.status, "resolved", `Reference resolver failed in ${row.id}`);
      counts.resolverSamples++;
    }
    counts.sessions++;
    if (counts.sessions % 50 === 0) console.log(JSON.stringify({ checkpoint: "anchor.audit", ...counts }));
  }
  console.log(JSON.stringify({ checkpoint: "anchor.audit.complete", ...counts }));
} finally {
  candidate.close();
  oldDb.close();
}
