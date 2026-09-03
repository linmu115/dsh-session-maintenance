import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  SqliteAdapterRegistryRepository,
  SqliteCanonicalRepository,
  SqliteNativeSessionReferenceRepository,
  SqliteProjectionRunRepository,
  SqliteSessionAliasRepository,
  openMaintenanceDatabase,
} from "../src/index.js";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const at = "2026-09-03T00:00:00.000Z";

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native session reference index", () => {
  it("combines source, active projection and historical alias identities without session content", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-native-reference-"));
    roots.push(root);
    const database = openMaintenanceDatabase(join(root, "metadata.sqlite"));
    databases.push(database);
    const logicalSessionId = "logical-reference-index" as never;
    await new SqliteCanonicalRepository(database).createCanonicalSession({
      schemaVersion: 1,
      id: logicalSessionId,
      authorityScope: "codex",
      originKind: "codex-mirror",
      headVersionId: null,
      title: "THIS TITLE MUST NOT ENTER THE INDEX",
      tags: [],
      archivedAt: null,
      tombstonedAt: null,
      createdAt: at,
      updatedAt: at,
    });
    database.prepare(
      `INSERT INTO platform_bindings
        (id, logical_session_id, platform, instance_id, session_id, adapter_contract_json,
         last_common_version_id, status)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'read-only')`,
    ).run(
      "binding-reference-index",
      logicalSessionId,
      "codex",
      "codex-local",
      "codex-thread-1",
      JSON.stringify({ adapter: "adapter-codex-read", platformVersion: "1", schemaFingerprint: "codex-v1" }),
    );
    await new SqliteAdapterRegistryRepository(database).upsertRegistration({
      manifest: {
        schemaVersion: 1,
        id: "adapter-alpha2" as never,
        displayName: "Alpha2 fixture",
        adapterApiVersion: 1,
        packageVersion: "1.0.0",
        testedDshVersions: ["0.1.2-alpha.2"],
        declaredDshRange: ">=0.1.2-alpha.2",
        capabilities: ["session-persistence"],
      },
      packageLocation: "fixture://adapter-alpha2",
      enabled: true,
      registeredAt: at,
      updatedAt: at,
    });
    const runs = new SqliteProjectionRunRepository(database);
    await runs.createProjectionRun({
      schemaVersion: 1,
      id: "run-reference-index" as never,
      leaseId: "lease-reference-index" as never,
      branchId: "main" as never,
      instanceId: "launcher-alpha2",
      profileId: "alpha2-stable",
      dshVersion: "0.1.2-alpha.2",
      adapterId: "adapter-alpha2" as never,
      state: "running",
      startedAt: at,
      heartbeatAt: at,
      checkpointId: null,
    });
    await runs.upsertProjectionSession({
      schemaVersion: 1,
      runId: "run-reference-index" as never,
      nativeSessionId: "dsh-session-current" as never,
      logicalSessionId,
      baseVersionId: null,
      mode: "codex-read-until-write",
      nativeRevision: 0,
      lastCommittedOperationId: null,
      derivedChildSessionId: null,
    });
    await new SqliteSessionAliasRepository(database).upsert({
      aliasKind: "legacy-reference",
      instanceId: "launcher-alpha1",
      nativeId: "dsh-session-old",
      target: { logicalSessionId, logicalWorkspaceId: null },
      createdAt: at,
      lastSeenAt: at,
    });

    const index = await new SqliteNativeSessionReferenceRepository(database).getReferenceIndex(logicalSessionId);
    expect(index?.references).toEqual([
      {
        schemaVersion: 1,
        logicalSessionId,
        platform: "codex",
        instanceId: "codex-local",
        nativeSessionId: "codex-thread-1",
        adapterId: "adapter-codex-read",
        referenceUse: "source",
        runId: null,
      },
      {
        schemaVersion: 1,
        logicalSessionId,
        platform: "dsh",
        instanceId: "launcher-alpha2",
        nativeSessionId: "dsh-session-current",
        adapterId: "adapter-alpha2",
        referenceUse: "active-projection",
        runId: "run-reference-index",
      },
      {
        schemaVersion: 1,
        logicalSessionId,
        platform: "dsh",
        instanceId: "launcher-alpha1",
        nativeSessionId: "dsh-session-old",
        adapterId: null,
        referenceUse: "historical-alias",
        runId: null,
      },
    ]);
    expect(JSON.stringify(index)).not.toContain("THIS TITLE MUST NOT ENTER THE INDEX");
    expect(await new SqliteNativeSessionReferenceRepository(database).getReferenceIndex("missing" as never)).toBeUndefined();
  });
});
