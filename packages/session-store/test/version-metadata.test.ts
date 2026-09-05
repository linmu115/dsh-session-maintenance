import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanonicalSessionEngine, metadataAtDerivationBase } from "@linmu/dsh-canonical-session-engine";
import type { CanonicalSessionEngineStore, CanonicalVersionRecord } from "@linmu/dsh-canonical-session-engine";
import type { LogicalSessionId, SessionVersionId } from "@linmu/dsh-session-contracts";
import { canonicalJson, normalizeSession, sha256Canonical, versionIdFor } from "@linmu/dsh-session-domain";
import {
  advanceCanonicalSessionMetadata, openMaintenanceDatabase, readVersionMetadataSnapshot,
  saveVersionMetadataSnapshot, SqliteCanonicalSessionEngineStore, SqliteSessionRepository, ZstdContentObjectStore,
} from "../src/index.js";

const roots: string[] = [];
const databases = new Set<DatabaseSync>();
const originAt = "2001-01-01T00:00:00.000Z";
const id = "logical-sm02-synthetic" as LogicalSessionId;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-sm02-synthetic-metadata-"));
  roots.push(root);
  await writeFile(join(root, ".synthetic-fixture"), "SM-02 synthetic test data only\n");
  const path = join(root, "metadata.sqlite");
  const database = openMaintenanceDatabase(path);
  databases.add(database);
  const objects = new ZstdContentObjectStore(root);
  const store = new SqliteCanonicalSessionEngineStore(database, objects);
  return { root, path, database, objects, store, engine: new CanonicalSessionEngine(store) };
}

function close(database: DatabaseSync) { databases.delete(database); database.close(); }
afterEach(async () => {
  for (const database of databases) database.close();
  databases.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const observation = {
  logicalSessionId: id, title: "Original", tags: ["original"], archivedAt: null,
  workspaceId: null, events: [], sourceCursor: null, observedAt: originAt,
} as const;

function expectDigests(version: CanonicalVersionRecord) {
  expect(sha256Canonical(version.body)).toBe(version.bodyDigest);
  expect(sha256Canonical(version.metadata)).toBe(version.metadataDigest);
  expect(sha256Canonical({ body: version.body, metadata: version.metadata })).toBe(version.contentDigest);
  expect(versionIdFor({ logicalSessionId: version.logicalSessionId, parents: version.parentVersionIds,
    bodyHash: version.bodyDigest, metadataHash: version.metadataDigest })).toBe(version.id);
  expect(version.contentDigest).not.toBe(version.id);
}

describe("version metadata snapshots", () => {
  it("keeps old metadata, reuses bodies, journals new heads, and records local persistence", async () => {
    const f = await fixture();
    const before = Date.now();
    const original = await f.engine.observeCodex(observation);
    const first = (await f.store.getVersion(original.versionId!))!;
    expect(Date.parse(first.firstPersistedAt!)).toBeGreaterThanOrEqual(before);
    expect(first.createdAt).toBe(originAt);
    const initialJournal = (await f.store.canonical.listChanges({ afterRevision: 0, limit: 1 })).currentRevision;
    const retitled = await f.engine.retitleCodexMirror({ logicalSessionId: id, title: "Retitled", appliedAt: originAt });
    const changed = advanceCanonicalSessionMetadata(f.database, {
      logicalSessionId: id, patch: { tags: ["new"], archived: true }, appliedAt: "2001-02-01T00:00:00.000Z",
    })!;
    const latest = (await f.store.getVersion(changed.versionId!))!;
    expect(await f.store.getVersion(original.versionId!)).toEqual(first);
    expect((await f.store.getVersion(retitled!.versionId!))!.metadata).toEqual({ title: "Retitled", tags: ["original"], archivedAt: null });
    expect(latest.metadata).toEqual({ title: "Retitled", tags: ["new"], archivedAt: "2001-02-01T00:00:00.000Z" });
    expect(latest.parentVersionIds).toEqual([retitled!.versionId]);
    expect(f.database.prepare("SELECT COUNT(DISTINCT body_object) AS count FROM session_versions").get()).toEqual({ count: 1 });
    expect((await f.store.canonical.listChanges({ afterRevision: initialJournal, limit: 100 })).changes.map((change) => change.kind))
      .toContain("content-updated");
    for (const version of [first, latest, (await f.store.getVersion(retitled!.versionId!))!]) expectDigests(version);
    const same = advanceCanonicalSessionMetadata(f.database, {
      logicalSessionId: id, patch: { tags: ["new"], archived: true }, appliedAt: "2099-01-01T00:00:00.000Z",
    });
    expect(same).toMatchObject({ outcome: "noop", versionId: latest.id });
    expect(await f.store.getVersion(latest.id)).toEqual(latest);
  });

  it("round-trips ordinary commits and duplicate versions without changing provenance or clocks", async () => {
    const f = await fixture();
    const commit = vi.spyOn(f.store, "commit");
    const result = await f.engine.observeCodex(observation);
    const mutation = commit.mock.calls[0]![0];
    const before = (await f.store.getVersion(result.versionId!))!;
    expect(before).toEqual({ ...mutation.version, firstPersistedAt: before.firstPersistedAt });
    await f.store.commit(mutation);
    expect(await f.store.getVersion(result.versionId!)).toEqual(before);
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM version_metadata_snapshots").get()).toEqual({ count: 1 });
    await expect(f.store.commit({ ...mutation, version: { ...mutation.version!, contentDigest: mutation.version!.id } }))
      .rejects.toThrow("digest or session metadata mismatch");
    await expect(f.store.commit({ ...mutation, version: null, session: { ...mutation.session, title: "Unversioned" } }))
      .rejects.toThrow("requires a version");
    expect(await f.store.getVersion(result.versionId!)).toEqual(before);
  });

  it("makes fast and ordinary retitle agree after workspace membership changed", async () => {
    const fast = await fixture();
    const ordinary = await fixture();
    await fast.engine.observeCodex(observation);
    await ordinary.engine.observeCodex(observation);
    for (const f of [fast, ordinary]) {
      await f.store.canonical.upsertLogicalWorkspace({ schemaVersion: 1, id: "workspace-later" as never, parentId: null,
        name: "Later", sortKey: "0", deletedAt: null, createdAt: originAt, updatedAt: originAt });
      await f.store.workspaces.setMembership({ schemaVersion: 1, logicalSessionId: id, workspaceId: "workspace-later" as never,
        displayOrder: 0, pinned: false, archived: false, revision: 1 });
    }
    const slowPort: CanonicalSessionEngineStore = {
      getSession: ordinary.store.getSession.bind(ordinary.store), getVersion: ordinary.store.getVersion.bind(ordinary.store),
      getOperationReceipt: ordinary.store.getOperationReceipt.bind(ordinary.store),
      recordCodexObservation: ordinary.store.recordCodexObservation.bind(ordinary.store), commit: ordinary.store.commit.bind(ordinary.store),
    };
    const patch = { logicalSessionId: id, title: "Same rename", appliedAt: originAt };
    const fastResult = await fast.engine.retitleCodexMirror(patch);
    const slowResult = await new CanonicalSessionEngine(slowPort).retitleCodexMirror(patch);
    expect(fastResult).toEqual(slowResult);
    const a = (await fast.store.getVersion(fastResult!.versionId!))!;
    const b = (await ordinary.store.getVersion(slowResult!.versionId!))!;
    expect({ ...a, firstPersistedAt: null }).toEqual({ ...b, firstPersistedAt: null });
    expectDigests(a);
  });

  it("rolls back versions, snapshots, heads and journal on normal and fast snapshot failures", async () => {
    const f = await fixture();
    const initial = await f.engine.observeCodex(observation);
    const before = await f.store.getSession(id);
    const journal = (await f.store.canonical.listChanges({ afterRevision: 0, limit: 1 })).currentRevision;
    f.database.exec(`CREATE TRIGGER synthetic_metadata_failure BEFORE UPDATE ON version_metadata_snapshots
      BEGIN SELECT RAISE(ABORT, 'synthetic snapshot failure'); END;`);
    await expect(f.engine.observeCodex({ ...observation, title: "Fail normal" })).rejects.toThrow("synthetic snapshot failure");
    await expect(f.engine.retitleCodexMirror({ logicalSessionId: id, title: "Fail fast", appliedAt: originAt }))
      .rejects.toThrow("synthetic snapshot failure");
    expect(await f.store.getSession(id)).toEqual(before);
    expect((await f.store.canonical.listChanges({ afterRevision: 0, limit: 1 })).currentRevision).toBe(journal);
    expect(f.database.prepare("SELECT id FROM session_versions").all()).toEqual([{ id: initial.versionId }]);
    expect(f.database.prepare("SELECT version_id FROM version_metadata_snapshots").all()).toEqual([{ version_id: initial.versionId }]);
    f.database.exec("DROP TRIGGER synthetic_metadata_failure");
    expect((await f.engine.retitleCodexMirror({ logicalSessionId: id, title: "Retry", appliedAt: originAt }))!.outcome).toBe("advanced");
  });

  it("distinguishes corrupt metadata from unknown history without losing the readable body", async () => {
    const f = await fixture();
    const initial = await f.engine.observeCodex(observation);
    const original = (await f.store.getVersion(initial.versionId!))!;
    expect(() => f.database.prepare("UPDATE version_metadata_snapshots SET metadata_json = '{}' WHERE version_id = ?")
      .run(initial.versionId)).toThrow("immutable");
    // Simulated on-disk corruption must still be detected after bypassing write protection.
    f.database.exec("DROP TRIGGER version_metadata_immutable");
    f.database.prepare("UPDATE version_metadata_snapshots SET metadata_json = '{}' WHERE version_id = ?").run(initial.versionId);
    const corrupt = (await f.store.getVersion(initial.versionId!))!;
    expect(corrupt).toMatchObject({ metadataAvailability: "corrupt", metadata: null, contentDigest: null,
      body: original.body, bodyDigest: original.bodyDigest });
    expect(() => metadataAtDerivationBase(corrupt)).toThrow(expect.objectContaining({ code: "OBJECT_CORRUPT" }));
  });

  it("captures immutable normalized import metadata through both legacy writers and retries", async () => {
    const f = await fixture();
    const repository = new SqliteSessionRepository(f.database, f.objects);
    const normalized = normalizeSession({ key: { platform: "codex", instanceId: "fixture", sessionId: "source" },
      title: "Legacy original", archived: true, workspaceId: null, events: [],
      provenance: { platform: "codex", instanceId: "fixture", sessionId: "source", observedAt: originAt },
      compatibility: { status: "compatible", issues: [] } });
    const bodyObject = await f.objects.put(Buffer.from(canonicalJson(normalized as never)));
    const logicalSession = { id: "legacy-import", displayTitle: "Current title is not evidence", canonicalVersionId: null,
      syncMode: "paused" as const, archived: false, labels: [], createdAt: originAt };
    await repository.createLogicalSession(logicalSession);
    const versionInput = { logicalSessionId: logicalSession.id, parents: [], bodyObject, bodyHash: normalized.bodyHash,
      metadataHash: normalized.metadataHash, source: normalized.provenance, compatibility: normalized.compatibility };
    const version = await repository.putVersion(versionInput);
    const snapshot = readVersionMetadataSnapshot(f.database, version.id);
    expect(snapshot).toMatchObject({ metadataAvailability: "available", metadataProvenance: "reconstructed-body",
      metadata: { title: "Legacy original", archived: true } });
    expect(snapshot.firstPersistedAt).not.toBe(originAt);
    await repository.putVersion(versionInput);
    expect(readVersionMetadataSnapshot(f.database, version.id)).toEqual(snapshot);
    const nextInput = { ...versionInput, parents: [version.id] };
    const next = { schemaVersion: 1 as const, ...nextInput, id: versionIdFor({ logicalSessionId: nextInput.logicalSessionId, parents: nextInput.parents, bodyHash: nextInput.bodyHash, metadataHash: nextInput.metadataHash }) };
    const binding = { id: "legacy-binding", logicalSessionId: logicalSession.id, key: normalized.key,
      adapterContract: { adapter: "codex-read", schemaFingerprint: "synthetic", platformVersion: "fixture" },
      lastCommonVersionId: null, status: "read-only" as const };
    const record = { logicalSession, binding, version: next, candidates: [], head: { bindingId: binding.id,
      versionId: next.id, observedAt: originAt, fingerprint: { platform: "codex", instanceId: "fixture", sessionId: "source", kind: "content", value: "synthetic" } as never } };
    await repository.recordObservedVersion(record);
    const observedSnapshot = readVersionMetadataSnapshot(f.database, next.id);
    expect(observedSnapshot.metadata).toEqual(snapshot.metadata);
    await repository.recordObservedVersion(record);
    expect(readVersionMetadataSnapshot(f.database, next.id)).toEqual(observedSnapshot);
    expect(Buffer.from(await f.objects.get(bodyObject))).toEqual(Buffer.from(canonicalJson(normalized as never)));
  });
});

describe("migration 017", () => {
  async function legacyFixture() {
    const f = await fixture();
    await f.engine.observeCodex(observation);
    await f.engine.retitleCodexMirror({ logicalSessionId: id, title: "Current", appliedAt: originAt });
    f.database.exec(`DROP TRIGGER session_version_metadata_created;
      DROP TRIGGER version_metadata_immutable; DROP TABLE version_metadata_snapshots;
      DELETE FROM schema_migrations WHERE version = 17;`);
    return f;
  }

  it("recovers only proven candidates, keeps unknown bodies and identities, and reopens idempotently", async () => {
    const f = await legacyFixture();
    const rows = f.database.prepare("SELECT * FROM session_versions ORDER BY id").all();
    const parents = f.database.prepare("SELECT * FROM version_parents ORDER BY version_id").all();
    const headId = (await f.store.getSession(id))!.headVersionId!;
    const originalId = (f.database.prepare("SELECT parent_id FROM version_parents WHERE version_id = ?").get(headId) as { parent_id: SessionVersionId }).parent_id;
    close(f.database);
    let database = openMaintenanceDatabase(f.path); databases.add(database);
    expect(database.prepare("SELECT * FROM session_versions ORDER BY id").all()).toEqual(rows);
    expect(database.prepare("SELECT * FROM version_parents ORDER BY version_id").all()).toEqual(parents);
    let store = new SqliteCanonicalSessionEngineStore(database, f.objects);
    const unknown = (await store.getVersion(originalId))!;
    expect(unknown).toMatchObject({ metadata: null, contentDigest: null, metadataAvailability: "unknown", firstPersistedAt: null, events: [] });
    expect(() => metadataAtDerivationBase(unknown)).toThrow("Historical metadata is unavailable");
    const recovered = (await store.getVersion(headId))!;
    expect(recovered).toMatchObject({ metadataAvailability: "available", metadataProvenance: "reconstructed-current", firstPersistedAt: null,
      metadata: { title: "Current", tags: ["original"], archivedAt: null } });
    expectDigests(recovered);
    const snapshots = database.prepare("SELECT * FROM version_metadata_snapshots ORDER BY version_id").all();
    close(database);
    database = openMaintenanceDatabase(f.path); databases.add(database);
    expect(database.prepare("SELECT * FROM version_metadata_snapshots ORDER BY version_id").all()).toEqual(snapshots);
    store = new SqliteCanonicalSessionEngineStore(database, f.objects);
    const advanced = await new CanonicalSessionEngine(store).observeCodex({ ...observation, title: "After upgrade" });
    expect((await store.getVersion(advanced.versionId!))!.firstPersistedAt).not.toBeNull();
    expect((await store.getVersion(originalId))!.metadataAvailability).toBe("unknown");
  });

  it("permits an explicit current edit while all old snapshots remain unknown", async () => {
    const f = await legacyFixture();
    f.database.prepare("UPDATE logical_sessions SET display_title = 'Unversioned legacy edit' WHERE id = ?").run(id);
    const headId = (await f.store.getSession(id))!.headVersionId!;
    close(f.database);
    const database = openMaintenanceDatabase(f.path); databases.add(database);
    const store = new SqliteCanonicalSessionEngineStore(database, f.objects);
    const unknown = (await store.getVersion(headId))!;
    expect(unknown.metadataAvailability).toBe("unknown");
    const updated = advanceCanonicalSessionMetadata(database, { logicalSessionId: id,
      patch: { title: "Unversioned legacy edit" }, appliedAt: originAt })!;
    expect(updated.outcome).toBe("advanced");
    expect((await store.getVersion(updated.versionId!))!.metadata).toEqual({ title: "Unversioned legacy edit", tags: ["original"], archivedAt: null });
    expect(await store.getVersion(headId)).toEqual(unknown);
    expect(() => saveVersionMetadataSnapshot(database, headId, { title: "Guess" }, "reconstructed-current"))
      .toThrow("digest mismatch");
  });

  it("rolls back registration on migration failure and retries without rewriting old versions", async () => {
    const f = await legacyFixture();
    const rows = f.database.prepare("SELECT * FROM session_versions ORDER BY id").all();
    f.database.exec(`CREATE TABLE synthetic_migration_conflict (value TEXT);
      CREATE TRIGGER session_version_metadata_created AFTER INSERT ON synthetic_migration_conflict BEGIN SELECT 1; END;`);
    close(f.database);
    expect(() => openMaintenanceDatabase(f.path)).toThrow("already exists");
    const inspect = new DatabaseSync(f.path);
    expect(inspect.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 16 });
    expect(inspect.prepare("SELECT * FROM session_versions ORDER BY id").all()).toEqual(rows);
    expect(inspect.prepare("SELECT name FROM sqlite_master WHERE name = 'version_metadata_snapshots'").get()).toBeUndefined();
    inspect.exec("DROP TRIGGER session_version_metadata_created; DROP TABLE synthetic_migration_conflict"); inspect.close();
    const repaired = openMaintenanceDatabase(f.path); databases.add(repaired);
    expect(repaired.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 17").get()).toEqual({ count: 1 });
    expect(repaired.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
