import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { activateDatabaseFile, initializeStateRoot, loadConfig } from "../../apps/engine/src/config.js";
import {
  activateCanonicalMigration,
  previewCanonicalMigration,
  ZstdContentObjectStore,
} from "../../packages/session-store/src/index.js";
import { MIGRATION_002 } from "../../packages/session-store/src/migrations/002-job-events.js";
import { MIGRATION_003 } from "../../packages/session-store/src/migrations/003-transactions.js";
import { MIGRATION_004 } from "../../packages/session-store/src/migrations/004-continuations.js";
import { MIGRATION_005 } from "../../packages/session-store/src/migrations/005-native-mirrors.js";
import { MIGRATION_006 } from "../../packages/session-store/src/migrations/006-workspace-directory.js";
import { MIGRATION_001 } from "../../packages/session-store/src/schema.js";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const at = "2026-08-31T00:00:00.000Z";

function createV6(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
  for (const [index, migration] of [MIGRATION_001, MIGRATION_002, MIGRATION_003, MIGRATION_004, MIGRATION_005, MIGRATION_006].entries()) {
    database.exec(migration);
    database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(index + 1, at);
  }
  return database;
}

async function seed(database: DatabaseSync, store: ZstdContentObjectStore, input: {
  readonly id: string;
  readonly platform: "codex" | "dsh";
  readonly workspaceId: string | null;
}): Promise<void> {
  const versionId = `version-${input.id}`;
  const bindingId = `binding-${input.id}`;
  const normalized = {
    schemaVersion: 1,
    key: { platform: input.platform, instanceId: `${input.platform}-fixture`, sessionId: `native-${input.id}` },
    title: `Title ${input.id}`,
    archived: false,
    workspaceId: input.workspaceId,
    events: [{
      id: `event-${input.id}`,
      parentId: null,
      sequence: 0,
      kind: "message",
      role: input.platform === "codex" ? "user" : "assistant",
      content: `content-${input.id}`,
      attachments: [],
      source: { platform: input.platform, instanceId: `${input.platform}-fixture`, sessionId: `native-${input.id}`, eventId: `source-${input.id}`, sequence: 0 },
      extensions: {},
    }],
    bodyHash: `body-${input.id}`,
    metadataHash: `metadata-${input.id}`,
    provenance: { platform: input.platform, instanceId: `${input.platform}-fixture`, sessionId: `native-${input.id}`, observedAt: at },
    compatibility: { status: "compatible", issues: [] },
  };
  const bodyObject = await store.put(Buffer.from(JSON.stringify(normalized), "utf8"));
  database.prepare(
    `INSERT INTO logical_sessions
      (id, display_title, canonical_version_id, sync_mode, archived, labels_json, created_at)
     VALUES (?, ?, NULL, 'paused', 0, '[]', ?)`,
  ).run(input.id, normalized.title, at);
  database.prepare(
    `INSERT INTO session_versions
      (id, logical_session_id, body_object, body_hash, metadata_hash, manifest_json, created_at)
     VALUES (?, ?, ?, ?, ?, '{}', ?)`,
  ).run(versionId, input.id, bodyObject, normalized.bodyHash, normalized.metadataHash, at);
  database.prepare(
    `INSERT INTO platform_bindings
      (id, logical_session_id, platform, instance_id, session_id, adapter_contract_json,
       last_common_version_id, status)
     VALUES (?, ?, ?, ?, ?, '{}', NULL, 'read-only')`,
  ).run(bindingId, input.id, input.platform, `${input.platform}-fixture`, `native-${input.id}`);
  database.prepare(
    "INSERT INTO platform_refs (binding_id, version_id, observed_at, fingerprint_json) VALUES (?, ?, ?, '{}')",
  ).run(bindingId, versionId, at);
  if (input.workspaceId !== null) {
    database.prepare(
      "INSERT INTO binding_workspaces (binding_id, workspace_id, display_name) VALUES (?, ?, ?)",
    ).run(bindingId, input.workspaceId, `Workspace ${input.workspaceId}`);
  }
}

async function fileDigest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("canonical migration activation", () => {
  it("converts a copied v6 database, preserves the source and switches only the config pointer", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-canonical-activation-"));
    roots.push(root);
    const source = join(root, "metadata.sqlite");
    const candidate = join(root, "metadata.canonical-candidate.sqlite");
    const archive = join(root, "metadata.pre-canonical-v6.sqlite");
    const database = createV6(source);
    databases.push(database);
    const store = new ZstdContentObjectStore(root);
    await seed(database, store, { id: "codex-session", platform: "codex", workspaceId: "workspace-a" });
    await seed(database, store, { id: "dsh-session", platform: "dsh", workspaceId: null });
    const sourceBefore = await fileDigest(source);
    const preview = await previewCanonicalMigration({ database, sourceDatabasePath: source, candidateDatabasePath: candidate });

    const activation = await activateCanonicalMigration({
      database,
      sourceDatabasePath: source,
      candidateDatabasePath: candidate,
      archiveDatabasePath: archive,
      expectedSourceDigest: preview.sourceDigest,
    });

    expect(activation).toMatchObject({
      schemaVersion: 10,
      sourcePreserved: true,
      pointerSwitchRequired: true,
      counts: { logicalSessions: 2, canonicalEvents: 2, logicalWorkspaces: 1, workspaceMemberships: 2 },
    });
    expect(await fileDigest(source)).toBe(sourceBefore);
    await expect(access(archive)).resolves.toBeUndefined();
    const migrated = new DatabaseSync(candidate, { readOnly: true });
    expect(migrated.prepare("SELECT id, authority_scope, origin_kind FROM logical_sessions ORDER BY id").all()).toEqual([
      { id: "codex-session", authority_scope: "codex", origin_kind: "codex-mirror" },
      { id: "dsh-session", authority_scope: "maintenance", origin_kind: "maintenance-native" },
    ]);
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM canonical_events").get()).toEqual({ count: 2 });
    migrated.close();

    await initializeStateRoot(root);
    expect((await loadConfig(root)).databaseFile).toBe("metadata.sqlite");
    await activateDatabaseFile(root, "metadata.canonical-candidate.sqlite");
    expect((await loadConfig(root)).databaseFile).toBe("metadata.canonical-candidate.sqlite");
  }, 20_000);
});
