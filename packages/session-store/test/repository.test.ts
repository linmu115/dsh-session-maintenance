import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  MIGRATION_001,
  MIGRATION_002,
  SqliteSessionRepository,
  ZstdContentObjectStore,
  openMaintenanceDatabase,
} from "../src/index.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-sm-repository-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SqliteSessionRepository", () => {
  it("upgrades a schema-2 database through the latest schema exactly once", async () => {
    const root = await temporaryRoot();
    const dbPath = join(root, "metadata.sqlite");
    const schemaTwo = new DatabaseSync(dbPath);
    schemaTwo.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
      ${MIGRATION_001}
      ${MIGRATION_002}
    `);
    schemaTwo
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?), (?, ?)")
      .run(1, "2026-08-26T00:00:00.000Z", 2, "2026-08-26T00:00:00.000Z");
    schemaTwo.close();

    let upgraded = openMaintenanceDatabase(dbPath);
    expect(
      upgraded.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
    ).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 },
      { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 },
      { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }, { version: 13 }, { version: 14 }, { version: 15 }, { version: 16 }, { version: 17 }, { version: 19 },
    ]);
    expect(
      upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transactions'").get(),
    ).toEqual({ name: "transactions" });
    expect(
      upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'continuation_jobs'").get(),
    ).toEqual({ name: "continuation_jobs" });
    expect(
      upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'native_mirrors'").get(),
    ).toEqual({ name: "native_mirrors" });
    expect(
      upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'binding_workspaces'").get(),
    ).toEqual({ name: "binding_workspaces" });
    upgraded.close();
    upgraded = openMaintenanceDatabase(dbPath);
    expect(
      upgraded.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 8").get(),
    ).toEqual({ count: 1 });
    upgraded.close();
  }, 15_000);

  it("persists immutable versions and observed refs across reopen", async () => {
    const root = await temporaryRoot();
    const store = new ZstdContentObjectStore(root);
    const bodyObject = await store.put(Buffer.from("same body"));
    const dbPath = join(root, "metadata.sqlite");
    let database = openMaintenanceDatabase(dbPath);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    let repository = new SqliteSessionRepository(database, store);

    expect(
      await repository.createLogicalSession({
        id: "ls_a",
        displayTitle: "A",
        canonicalVersionId: null,
        syncMode: "paused",
        archived: false,
        labels: [],
        createdAt: "2026-08-26T00:00:00.000Z",
      }),
    ).toBe(true);

    const versionInput = {
      logicalSessionId: "ls_a",
      parents: [],
      bodyObject,
      bodyHash: "body-a",
      metadataHash: "meta-a",
      source: {
        platform: "dsh" as const,
        instanceId: "d",
        sessionId: "s",
        observedAt: "2026-08-26T00:00:00.000Z",
      },
      compatibility: { status: "compatible" as const, issues: [] },
    };
    const manifest = await repository.putVersion(versionInput);
    expect(await repository.putVersion(versionInput)).toEqual(manifest);

    database
      .prepare(
        `INSERT INTO platform_bindings
          (id, logical_session_id, platform, instance_id, session_id, adapter_contract_json,
           last_common_version_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "binding-a",
        "ls_a",
        "dsh",
        "d",
        "s",
        JSON.stringify({
          adapter: "fixture",
          platformVersion: "0.1.1-rc.2",
          schemaFingerprint: "fixture",
        }),
        null,
        "read-only",
      );
    await repository.recordObservation({
      bindingId: "binding-a",
      versionId: manifest.id,
      observedAt: "2026-08-26T00:01:00.000Z",
      fingerprint: {
        platform: "dsh",
        instanceId: "d",
        sessionId: "s",
        kind: "content",
        value: "fingerprint-a",
      },
    });
    await repository.recordWorkspaceMembership({
      bindingId: "binding-a",
      workspaceId: "workspace_alpha",
      displayName: "Alpha",
    });
    expect((await repository.listSessions({ workspaceId: "workspace_alpha" })).items[0]?.workspace).toEqual({
      id: "workspace_alpha",
      name: "Alpha",
    });
    expect(await repository.listWorkspaces()).toMatchObject([{
      workspace: { id: "workspace_alpha", name: "Alpha" },
      sessionCount: 1,
      platforms: ["dsh"],
    }]);
    expect(await repository.listReachableObjectIds()).toEqual([bodyObject]);

    repository.close();
    database = openMaintenanceDatabase(dbPath);
    repository = new SqliteSessionRepository(database, store);
    expect((await repository.getGraph("ls_a")).nodes).toContainEqual({
      id: manifest.id,
      parents: [],
    });
    repository.close();
  });

  it("refuses newer schema versions and manifest identity collisions", async () => {
    const root = await temporaryRoot();
    const dbPath = join(root, "metadata.sqlite");
    const database = openMaintenanceDatabase(dbPath);
    database
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(999, "2026-08-26T00:00:00.000Z");
    database.close();
    expect(() => openMaintenanceDatabase(dbPath)).toThrow(/newer schema/iu);

    const collisionRoot = await temporaryRoot();
    const store = new ZstdContentObjectStore(collisionRoot);
    const bodyObject = await store.put(Buffer.from("body"));
    const collisionDatabase = openMaintenanceDatabase(join(collisionRoot, "metadata.sqlite"));
    const repository = new SqliteSessionRepository(collisionDatabase, store);
    await repository.createLogicalSession({
      id: "ls_collision",
      displayTitle: "collision",
      canonicalVersionId: null,
      syncMode: "paused",
      archived: false,
      labels: [],
      createdAt: "2026-08-26T00:00:00.000Z",
    });
    const input = {
      logicalSessionId: "ls_collision",
      parents: [],
      bodyObject,
      bodyHash: "body",
      metadataHash: "metadata",
      source: {
        platform: "codex" as const,
        instanceId: "c",
        sessionId: "s",
        observedAt: "2026-08-26T00:00:00.000Z",
      },
      compatibility: { status: "compatible" as const, issues: [] },
    };
    const manifest = await repository.putVersion(input);
    collisionDatabase
      .prepare("UPDATE session_versions SET manifest_json = ? WHERE id = ?")
      .run("{}", manifest.id);
    await expect(repository.putVersion(input)).rejects.toMatchObject({
      code: "VERSION_ID_COLLISION",
    });
    repository.close();
  });
});
