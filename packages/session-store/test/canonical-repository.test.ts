import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
import type {
  CanonicalSessionRecord,
  LogicalSessionId,
  LogicalWorkspaceId,
  OperationId,
  SessionDerivation,
} from "@linmu/dsh-session-contracts";

import { SqliteCanonicalRepository, openMaintenanceDatabase } from "../src/index.js";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const createdAt = "2026-08-31T00:00:00.000Z";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-sm-canonical-repository-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function session(
  id: string,
  authorityScope: CanonicalSessionRecord["authorityScope"],
  originKind: CanonicalSessionRecord["originKind"],
): CanonicalSessionRecord {
  return {
    schemaVersion: 1,
    id: id as LogicalSessionId,
    authorityScope,
    originKind,
    headVersionId: null,
    title: id,
    tags: ["fixture"],
    archivedAt: null,
    tombstonedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("SqliteCanonicalRepository", () => {
  it("atomically creates a derived canonical session and operation-unique lineage", async () => {
    const root = await temporaryRoot();
    const database = openMaintenanceDatabase(join(root, "metadata.sqlite"));
    databases.push(database);
    const repository = new SqliteCanonicalRepository(database);
    const parent = session("logical-codex-parent", "codex", "codex-mirror");
    const child = session("logical-dsh-child", "maintenance", "codex-derived");

    expect(await repository.createCanonicalSession(parent)).toBe(true);
    database
      .prepare(
        `INSERT INTO session_versions
          (id, logical_session_id, body_object, body_hash, metadata_hash, manifest_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "base-version-1",
        parent.id,
        "sha256:base-object",
        "sha256:base-body",
        "sha256:base-metadata",
        "{}",
        createdAt,
      );
    const derivation: SessionDerivation = {
      schemaVersion: 1,
      childSessionId: child.id,
      parentSessionId: parent.id,
      baseVersionId: "base-version-1" as SessionDerivation["baseVersionId"],
      kind: "dsh-continuation",
      triggerRunId: "run-alpha2-1" as SessionDerivation["triggerRunId"],
      triggerOperationId: "operation-derive-1" as OperationId,
      createdAt,
    };

    expect(await repository.createDerivedCanonicalSession({ session: child, derivation })).toBe(true);
    expect(await repository.getCanonicalSession(child.id)).toEqual(child);
    expect(await repository.findDerivationByOperationId(derivation.triggerOperationId)).toEqual(
      derivation,
    );

    const conflictingChild = session(
      "logical-dsh-conflict",
      "maintenance",
      "codex-derived",
    );
    await expect(
      repository.createDerivedCanonicalSession({
        session: conflictingChild,
        derivation: { ...derivation, childSessionId: conflictingChild.id },
      }),
    ).rejects.toThrow(/operation/iu);
    expect(await repository.getCanonicalSession(conflictingChild.id)).toBeUndefined();

  });

  it("enforces derivation source and one logical workspace membership", async () => {
    const root = await temporaryRoot();
    const database = openMaintenanceDatabase(join(root, "metadata.sqlite"));
    databases.push(database);
    const repository = new SqliteCanonicalRepository(database);
    const standalone = session("logical-standalone", "maintenance", "maintenance-native");
    const parent = session("logical-source-parent", "codex", "codex-mirror");
    await repository.createCanonicalSession(standalone);
    await repository.createCanonicalSession(parent);
    database
      .prepare(
        `INSERT INTO session_versions
          (id, logical_session_id, body_object, body_hash, metadata_hash, manifest_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "source-base-version",
        parent.id,
        "sha256:source-object",
        "sha256:source-body",
        "sha256:source-metadata",
        "{}",
        createdAt,
      );

    await repository.upsertLogicalWorkspace({
      schemaVersion: 1,
      id: "workspace-one" as LogicalWorkspaceId,
      parentId: null,
      name: "One",
      sortKey: "0001",
      deletedAt: null,
      createdAt,
      updatedAt: createdAt,
    });
    await repository.upsertLogicalWorkspace({
      schemaVersion: 1,
      id: "workspace-two" as LogicalWorkspaceId,
      parentId: null,
      name: "Two",
      sortKey: "0002",
      deletedAt: null,
      createdAt,
      updatedAt: createdAt,
    });
    await repository.setWorkspaceMembership({
      schemaVersion: 1,
      logicalSessionId: standalone.id,
      workspaceId: "workspace-one" as LogicalWorkspaceId,
      displayOrder: 0,
      pinned: false,
      archived: false,
      revision: 1,
    });
    await repository.setWorkspaceMembership({
      schemaVersion: 1,
      logicalSessionId: standalone.id,
      workspaceId: "workspace-two" as LogicalWorkspaceId,
      displayOrder: 2,
      pinned: true,
      archived: false,
      revision: 2,
    });

    expect(await repository.workspaces.getMembership(standalone.id)).toMatchObject({
      workspaceId: "workspace-two",
      revision: 2,
    });
    await repository.aliases.upsert({
      aliasKind: "dsh-session",
      instanceId: "launcher-alpha2",
      nativeId: "native-session-1",
      target: { logicalSessionId: standalone.id, logicalWorkspaceId: null },
      createdAt,
      lastSeenAt: createdAt,
    });
    expect(
      await repository.aliases.resolve(
        "dsh-session",
        "launcher-alpha2",
        "native-session-1",
      ),
    ).toMatchObject({ target: { logicalSessionId: standalone.id } });
    const event = {
      schemaVersion: 1 as const,
      id: "canonical-event-1",
      logicalSessionId: standalone.id,
      sequence: 0,
      kind: "user-message" as const,
      role: "user" as const,
      content: { text: "hello" },
      source: {
        platform: "dsh" as const,
        instanceId: "launcher-alpha2",
        sessionId: "native-session-1",
        eventId: "native-event-1",
        cursor: "0",
      },
      contentDigest: "sha256:canonical-event-1",
      rawPayload: null,
      extensions: {},
    };
    expect(await repository.putCanonicalEvent(event)).toBe(true);
    expect(await repository.putCanonicalEvent(event)).toBe(false);
    await expect(
      repository.recordDerivation({
        schemaVersion: 1,
        childSessionId: standalone.id,
        parentSessionId: parent.id,
        baseVersionId: "source-base-version" as SessionDerivation["baseVersionId"],
        kind: "dsh-continuation",
        triggerRunId: "run-invalid" as SessionDerivation["triggerRunId"],
        triggerOperationId: "operation-invalid" as OperationId,
        createdAt,
      }),
    ).rejects.toThrow(/codex-derived/iu);

  });
});
