import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
import { adapter, alpha2NativeSessionId } from "../../packages/adapter-dsh-alpha2/src/index.js";
import { StatusLog, SqliteStatusEventAdapter } from "../../packages/session-status-log/src/index.js";
import {
  SqliteAdapterRegistryRepository,
  SqliteCanonicalRepository,
  SqliteProjectionRunRepository,
  SqliteStatusEventRepository,
  openMaintenanceDatabase,
} from "../../packages/session-store/src/index.js";
import {
  JsonProjectionDirectory,
  ProjectionLifecycle,
  SqliteCanonicalProjectionSource,
} from "../../packages/projection-lifecycle/src/index.js";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const at = "2026-08-31T00:00:00.000Z";

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Alpha2 projection open integration", () => {
  it("lists a synthetic Maintenance session from a run-scoped projection with durable P1-P3 status", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-alpha2-open-"));
    roots.push(root);
    const database = openMaintenanceDatabase(join(root, "metadata.sqlite"));
    databases.push(database);
    const canonical = new SqliteCanonicalRepository(database);
    const workspaceId = "workspace-alpha2-integration" as never;
    const projectId = "project-alpha2-integration" as never;
    const projectRoot = "D:\\fixture\\alpha2-project-root";
    const logicalSessionId = "logical-alpha2-integration" as never;
    await canonical.upsertLogicalWorkspace({
      schemaVersion: 1,
      id: workspaceId,
      parentId: null,
      name: "Synthetic integration workspace",
      sortKey: "0001",
      deletedAt: null,
      createdAt: at,
      updatedAt: at,
    });
    await canonical.createCanonicalSession({
      schemaVersion: 1,
      id: logicalSessionId,
      authorityScope: "maintenance",
      originKind: "maintenance-native",
      headVersionId: null,
      title: "Synthetic integration session",
      tags: ["fixture"],
      archivedAt: null,
      tombstonedAt: null,
      createdAt: at,
      updatedAt: at,
    });
    await canonical.setWorkspaceMembership({
      schemaVersion: 1,
      logicalSessionId,
      workspaceId,
      displayOrder: 0,
      pinned: false,
      archived: false,
      revision: 0,
    });
    await canonical.upsertLogicalProject({
      schemaVersion: 1,
      id: projectId,
      name: "Synthetic integration project",
      sourcePlatform: "maintenance",
      sourceProjectId: null,
      sortKey: "0001",
      deletedAt: null,
      createdAt: at,
      updatedAt: at,
    });
    await canonical.replaceProjectRoots(projectId, [{
      schemaVersion: 1,
      projectId,
      path: projectRoot,
      normalizedPath: "d:\\fixture\\alpha2-project-root",
      ordinal: 0,
    }]);
    await canonical.setProjectMembership({
      schemaVersion: 1,
      logicalSessionId,
      projectId,
      revision: 0,
    });
    await canonical.putCanonicalEvent({
      schemaVersion: 1,
      id: "event-alpha2-integration",
      logicalSessionId,
      sequence: 0,
      kind: "user-message",
      role: "user",
      content: { role: "user", content: [{ type: "text", text: "synthetic only" }], source: { kind: "user" } },
      source: { platform: "dsh", instanceId: "fixture", sessionId: "fixture", eventId: "0", cursor: "0" },
      contentDigest: "sha256:synthetic",
      rawPayload: null,
      extensions: {},
    });
    await new SqliteAdapterRegistryRepository(database).upsertRegistration({
      manifest: adapter.manifest,
      packageLocation: "workspace:@linmu/dsh-session-adapter-alpha2",
      enabled: true,
      registeredAt: at,
      updatedAt: at,
    });
    let nextId = 0;
    const lifecycle = new ProjectionLifecycle({
      runRepository: new SqliteProjectionRunRepository(database),
      statusLog: new StatusLog(
        new SqliteStatusEventAdapter(new SqliteStatusEventRepository(database)),
        { clock: () => at, idFactory: (kind) => `${kind}-${String(++nextId).padStart(3, "0")}` },
      ),
      source: new SqliteCanonicalProjectionSource(database),
      adapter,
      bridge: {
        attach: async (context) => ({ runId: context.run.id, adapterId: adapter.manifest.id, attachedAt: at }),
        drain: async (handle) => ({ runId: handle.runId, pendingOperations: 0, receipts: [] }),
        detach: async () => undefined,
      },
      runtimeRoot: join(root, "maintenance-runtime"),
      clock: () => at,
      idFactory: (kind) => `${kind}-${String(++nextId).padStart(3, "0")}`,
    });
    const handle = await lifecycle.openRun({
      instanceId: "alpha2-integration",
      profileId: "alpha2-stable",
      dshVersion: "0.1.2-alpha.2",
      branchId: "main" as never,
      maintenanceEndpoint: "http://127.0.0.1:41781",
    });

    const projection = new JsonProjectionDirectory(handle.projectionRoot);
    expect(await projection.listNativeSessionIds()).toEqual([alpha2NativeSessionId(logicalSessionId)]);
    expect(await projection.readSession(alpha2NativeSessionId(logicalSessionId))).toMatchObject({
      logicalSessionId,
      workspaceId,
      projectId,
      header: { version: 0, cwd: projectRoot },
      events: [{ type: "user/message", seq: 0 }],
    });
    const persisted = await new SqliteStatusEventRepository(database).listStatusEvents({ runId: handle.run.id, limit: 100 });
    expect(persisted.items.map((event) => `${event.stage}:${event.state}`)).toEqual([
      "run.lease:started",
      "run.lease:succeeded",
      "projection.materialize:started",
      "projection.delta-apply:started",
      "projection.delta-apply:succeeded",
      "projection.materialize:succeeded",
      "runtime.persistence.attach:started",
      "runtime.persistence.attach:succeeded",
    ]);
  });
});
