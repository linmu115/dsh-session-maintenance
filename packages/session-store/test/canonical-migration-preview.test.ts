import { createHash } from "node:crypto";
import { access, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { previewCanonicalMigration } from "../src/index.js";
import { MIGRATION_002 } from "../src/migrations/002-job-events.js";
import { MIGRATION_003 } from "../src/migrations/003-transactions.js";
import { MIGRATION_004 } from "../src/migrations/004-continuations.js";
import { MIGRATION_005 } from "../src/migrations/005-native-mirrors.js";
import { MIGRATION_006 } from "../src/migrations/006-workspace-directory.js";
import { MIGRATION_001 } from "../src/schema.js";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const at = "2026-08-31T00:00:00.000Z";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-sm-canonical-preview-"));
  roots.push(root);
  return root;
}

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function createV6(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  for (const [index, migration] of [
    MIGRATION_001,
    MIGRATION_002,
    MIGRATION_003,
    MIGRATION_004,
    MIGRATION_005,
    MIGRATION_006,
  ].entries()) {
    database.exec(migration);
    database
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(index + 1, at);
  }
  return database;
}

function seedSession(
  database: DatabaseSync,
  id: string,
  input: {
    readonly codexVersionId: string | null;
    readonly dshVersionId: string | null;
    readonly commonVersionId: string | null;
    readonly withMirror?: boolean;
  },
): void {
  database
    .prepare(
      `INSERT INTO logical_sessions
        (id, display_title, canonical_version_id, sync_mode, archived, labels_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, id, null, "paused", 0, "[]", at);
  const versionIds = new Set([
    input.codexVersionId,
    input.dshVersionId,
    input.commonVersionId,
  ].filter((value): value is string => value !== null));
  for (const versionId of versionIds) {
    database
      .prepare(
        `INSERT INTO session_versions
          (id, logical_session_id, body_object, body_hash, metadata_hash, manifest_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(versionId, id, `object-${versionId}`, `body-${versionId}`, "metadata", "{}", at);
  }
  const codexBindingId = input.codexVersionId === null ? null : `binding-codex-${id}`;
  const dshBindingId = input.dshVersionId === null ? null : `binding-dsh-${id}`;
  for (const [bindingId, platform, versionId] of [
    [codexBindingId, "codex", input.codexVersionId],
    [dshBindingId, "dsh", input.dshVersionId],
  ] as const) {
    if (bindingId === null || versionId === null) continue;
    database
      .prepare(
        `INSERT INTO platform_bindings
          (id, logical_session_id, platform, instance_id, session_id, adapter_contract_json,
           last_common_version_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(bindingId, id, platform, `${platform}-fixture`, `${platform}-${id}`, "{}", input.commonVersionId, "read-only");
  }
  if (input.withMirror === false) return;
  database
    .prepare(
      `INSERT INTO native_mirrors
        (logical_session_id, state, codex_binding_id, dsh_binding_id, common_version_id,
         codex_version_id, dsh_version_id, last_transaction_id, pause_reason, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      "paused",
      codexBindingId,
      dshBindingId,
      input.commonVersionId,
      input.codexVersionId,
      input.dshVersionId,
      null,
      "fixture",
      at,
    );
  const workspaceBinding = codexBindingId ?? dshBindingId;
  if (workspaceBinding !== null) {
    database
      .prepare(
        "INSERT INTO binding_workspaces (binding_id, workspace_id, display_name) VALUES (?, ?, ?)",
      )
      .run(workspaceBinding, `workspace-${id}`, `Workspace ${id}`);
  }
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("canonical migration preview", () => {
  it("classifies six v6 mirror shapes without changing any source byte", async () => {
    const root = await temporaryRoot();
    const sourceDatabasePath = join(root, "metadata-v6.sqlite");
    const candidateDatabasePath = join(root, "metadata-canonical-candidate.sqlite");
    const database = createV6(sourceDatabasePath);
    databases.push(database);
    seedSession(database, "codex-only", { codexVersionId: "v-codex", dshVersionId: null, commonVersionId: null });
    seedSession(database, "dsh-only", { codexVersionId: null, dshVersionId: "v-dsh", commonVersionId: null });
    seedSession(database, "equal", { codexVersionId: "v-equal", dshVersionId: "v-equal", commonVersionId: "v-equal" });
    seedSession(database, "source-ahead", { codexVersionId: "v-source-new", dshVersionId: "v-source-base", commonVersionId: "v-source-base" });
    seedSession(database, "target-ahead", { codexVersionId: "v-target-base", dshVersionId: "v-target-new", commonVersionId: "v-target-base" });
    seedSession(database, "diverged", { codexVersionId: "v-diverged-codex", dshVersionId: "v-diverged-dsh", commonVersionId: "v-diverged-base" });
    seedSession(database, "unclassified", { codexVersionId: null, dshVersionId: null, commonVersionId: null, withMirror: false });
    const before = await digest(sourceDatabasePath);

    const preview = await previewCanonicalMigration({
      database,
      sourceDatabasePath,
      candidateDatabasePath,
    });

    expect(preview.sourceSchemaVersion).toBe(6);
    expect(preview.counts).toEqual({
      sourceLogicalSessions: 7,
      codexMirror: 4,
      maintenanceNative: 1,
      codexDerived: 1,
      reviewRequired: 1,
      unclassified: 1,
    });
    expect(Object.fromEntries(preview.classifications.map((item) => [item.logicalSessionId, item.disposition]))).toEqual({
      "codex-only": "codex-mirror",
      "dsh-only": "maintenance-native",
      equal: "codex-mirror",
      "source-ahead": "codex-mirror",
      "target-ahead": "codex-mirror-with-derived-child",
      diverged: "review-required",
      unclassified: "unclassified",
    });
    expect(preview.classifications.find((item) => item.logicalSessionId === "diverged")).toMatchObject({
      proposedSessionIds: [],
      reasonCode: "DIVERGED_REQUIRES_REVIEW",
    });
    expect(preview.sourceFiles).toEqual([
      expect.objectContaining({ path: sourceDatabasePath, digest: before }),
    ]);
    expect(preview.candidate).toEqual({ path: candidateDatabasePath, exists: false, created: false });
    expect(preview.rollback).toMatchObject({ sourcePreserved: true, activationRequired: true });
    await expect(access(candidateDatabasePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await digest(sourceDatabasePath)).toBe(before);
    expect(database.prepare("SELECT COUNT(*) AS count FROM logical_sessions").get()).toEqual({ count: 7 });
  }, 15_000);
});
