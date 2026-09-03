import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
import type { CanonicalSessionRecord, LogicalProjectId, LogicalSessionId, LogicalWorkspaceId } from "@linmu/dsh-session-contracts";

import {
  MIGRATION_001,
  MIGRATION_002,
  MIGRATION_003,
  MIGRATION_004,
  MIGRATION_005,
  MIGRATION_006,
  MIGRATION_007,
  MIGRATION_008,
  MIGRATION_009,
  MIGRATION_010,
  MIGRATION_011,
  SqliteCanonicalRepository,
  openMaintenanceDatabase,
} from "../src/index.js";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const at = "2026-09-03T00:00:00.000Z";

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function session(id: string, authorityScope: "codex" | "maintenance", originKind: "codex-mirror" | "maintenance-native" | "codex-derived"): CanonicalSessionRecord {
  return {
    schemaVersion: 1,
    id: id as LogicalSessionId,
    authorityScope,
    originKind,
    headVersionId: null,
    title: id,
    tags: [],
    archivedAt: null,
    tombstonedAt: null,
    createdAt: at,
    updatedAt: at,
  };
}

describe("migration 012 canonical change journal", () => {
  it("seeds v11 sessions and pages only lightweight changes in revision order", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-migration-012-"));
    roots.push(root);
    const path = join(root, "metadata.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
      ${MIGRATION_001}
      ${MIGRATION_002}
      ${MIGRATION_003}
      ${MIGRATION_004}
      ${MIGRATION_005}
      ${MIGRATION_006}
      ${MIGRATION_007}
      ${MIGRATION_008}
      ${MIGRATION_009}
      ${MIGRATION_010}
      ${MIGRATION_011}
    `);
    const migration = legacy.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
    for (let version = 1; version <= 11; version += 1) migration.run(version, at);
    legacy.prepare(
      `INSERT INTO logical_sessions
        (id, display_title, canonical_version_id, sync_mode, archived, labels_json, created_at,
         authority_scope, origin_kind, head_version_id, archived_at, tombstoned_at, updated_at)
       VALUES (?, ?, NULL, 'paused', 0, '[]', ?, 'maintenance', 'maintenance-native', NULL, NULL, NULL, ?)`,
    ).run("logical-existing", "Existing", at, at);
    legacy.close();

    const database = openMaintenanceDatabase(path);
    databases.push(database);
    const repository = new SqliteCanonicalRepository(database);
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 14 });
    expect(await repository.listChanges({ afterRevision: 0, limit: 100 })).toMatchObject({
      throughRevision: 1,
      currentRevision: 1,
      hasMore: false,
      changes: [{ revision: 1, logicalSessionId: "logical-existing", kind: "session-created" }],
    });

    database.prepare(
      "UPDATE logical_sessions SET display_title = ?, updated_at = ? WHERE id = ?",
    ).run("Renamed", "2026-09-03T00:01:00.000Z", "logical-existing");
    await repository.upsertLogicalWorkspace({
      schemaVersion: 1,
      id: "workspace-one" as LogicalWorkspaceId,
      parentId: null,
      name: "Workspace",
      sortKey: "0001",
      deletedAt: null,
      createdAt: at,
      updatedAt: at,
    });
    await repository.setWorkspaceMembership({
      schemaVersion: 1,
      logicalSessionId: "logical-existing" as LogicalSessionId,
      workspaceId: "workspace-one" as LogicalWorkspaceId,
      displayOrder: 0,
      pinned: false,
      archived: false,
      revision: 1,
    });
    await repository.upsertLogicalProject({
      schemaVersion: 1,
      id: "project-one" as LogicalProjectId,
      name: "Project",
      sourcePlatform: "maintenance",
      sourceProjectId: null,
      sortKey: "0001",
      deletedAt: null,
      createdAt: at,
      updatedAt: at,
    });
    await repository.setProjectMembership({
      schemaVersion: 1,
      logicalSessionId: "logical-existing" as LogicalSessionId,
      projectId: "project-one" as LogicalProjectId,
      revision: 1,
    });
    const event = {
      schemaVersion: 1 as const,
      id: "event-one",
      logicalSessionId: "logical-existing" as LogicalSessionId,
      sequence: 0,
      kind: "user-message" as const,
      role: "user" as const,
      content: { text: "fixture" },
      source: { platform: "dsh" as const, instanceId: "fixture", sessionId: "native", eventId: "event", cursor: "0" },
      contentDigest: "sha256:event-one",
      rawPayload: null,
      extensions: {},
    };
    expect(await repository.putCanonicalEvent(event)).toBe(true);
    expect(await repository.putCanonicalEvent(event)).toBe(false);
    database.prepare(
      "UPDATE logical_sessions SET tombstoned_at = ?, updated_at = ? WHERE id = ?",
    ).run("2026-09-03T00:02:00.000Z", "2026-09-03T00:02:00.000Z", "logical-existing");

    const first = await repository.listChanges({ afterRevision: 0, limit: 2 });
    expect(first).toMatchObject({ throughRevision: 2, currentRevision: 6, hasMore: true });
    expect(first.changes.map((change) => change.kind)).toEqual(["session-created", "metadata-updated"]);
    const second = await repository.listChanges({ afterRevision: first.throughRevision, limit: 10 });
    expect(second).toMatchObject({ throughRevision: 6, currentRevision: 6, hasMore: false });
    expect(second.changes.map((change) => change.kind)).toEqual([
      "workspace-updated",
      "project-updated",
      "content-updated",
      "tombstone-updated",
    ]);
    expect(JSON.stringify(second)).not.toContain("fixture");
    await expect(repository.listChanges({ afterRevision: 7, limit: 10 })).rejects.toThrow(/exceeds current revision/iu);

    // Replaying identical catalog writes must not manufacture a new revision.
    await repository.setWorkspaceMembership({
      schemaVersion: 1,
      logicalSessionId: "logical-existing" as LogicalSessionId,
      workspaceId: "workspace-one" as LogicalWorkspaceId,
      displayOrder: 0,
      pinned: false,
      archived: false,
      revision: 1,
    });
    expect((await repository.listChanges({ afterRevision: 6, limit: 10 })).changes).toEqual([]);

    const parent = session("logical-parent", "codex", "codex-mirror");
    const child = session("logical-child", "maintenance", "codex-derived");
    await repository.createCanonicalSession(parent);
    database.prepare(
      `INSERT INTO session_versions
        (id, logical_session_id, body_object, body_hash, metadata_hash, manifest_json, created_at)
       VALUES ('version-parent', ?, 'object', 'body', 'metadata', '{}', ?)`,
    ).run(parent.id, at);
    await repository.createDerivedCanonicalSession({
      session: child,
      derivation: {
        schemaVersion: 1,
        childSessionId: child.id,
        parentSessionId: parent.id,
        baseVersionId: "version-parent" as never,
        kind: "dsh-continuation",
        triggerRunId: "run-one" as never,
        triggerOperationId: "operation-one" as never,
        createdAt: at,
      },
    });
    const branchPage = await repository.listChanges({ afterRevision: 6, limit: 10 });
    expect(branchPage.changes.map((change) => [change.logicalSessionId, change.kind])).toEqual([
      ["logical-parent", "session-created"],
      ["logical-child", "session-created"],
      ["logical-child", "branch-created"],
    ]);
  }, 20_000);
});
