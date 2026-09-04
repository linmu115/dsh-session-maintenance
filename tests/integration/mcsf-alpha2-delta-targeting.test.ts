import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
import { adapter, alpha2NativeSessionId } from "../../packages/adapter-dsh-alpha2/src/index.js";
import {
  PersistentProjectionCache,
  SqliteCanonicalProjectionSource,
} from "../../packages/projection-lifecycle/src/index.js";
import {
  SqliteCanonicalRepository,
  openMaintenanceDatabase,
} from "../../packages/session-store/src/index.js";
import { MemoryStatusEventAdapter, StatusLog } from "../../packages/session-status-log/src/index.js";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const at = "2026-09-03T00:00:00.000Z";

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function run(id: string) {
  return {
    schemaVersion: 1 as const,
    id: id as never,
    leaseId: `lease-${id}` as never,
    branchId: "main" as never,
    instanceId: "alpha2-acceptance",
    profileId: "web",
    dshVersion: "0.1.2-alpha.2",
    adapterId: adapter.manifest.id,
    state: "preparing" as const,
    startedAt: at,
    heartbeatAt: at,
    checkpointId: null,
  };
}

async function seed(
  canonical: SqliteCanonicalRepository,
  suffix: "a" | "b",
): Promise<void> {
  const logicalSessionId = `logical-${suffix}` as never;
  const workspaceId = `workspace-${suffix}` as never;
  const projectId = `project-${suffix}` as never;
  await canonical.upsertLogicalWorkspace({
    schemaVersion: 1,
    id: workspaceId,
    parentId: null,
    name: `Workspace ${suffix.toUpperCase()}`,
    sortKey: suffix,
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
    title: `Session ${suffix.toUpperCase()}`,
    tags: [],
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
    name: `Project ${suffix.toUpperCase()}`,
    sourcePlatform: "maintenance",
    sourceProjectId: null,
    sortKey: suffix,
    deletedAt: null,
    createdAt: at,
    updatedAt: at,
  });
  await canonical.replaceProjectRoots(projectId, [{
    schemaVersion: 1,
    projectId,
    path: `D:\\fixture\\project-${suffix}`,
    normalizedPath: `d:\\fixture\\project-${suffix}`,
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
    id: `event-${suffix}`,
    logicalSessionId,
    sequence: 0,
    kind: "user-message",
    role: "user",
    content: `Message ${suffix.toUpperCase()}`,
    source: {
      platform: "dsh",
      instanceId: "fixture",
      sessionId: `native-${suffix}`,
      eventId: `event-${suffix}`,
      cursor: "0",
    },
    contentDigest: `sha256:event-${suffix}`,
    rawPayload: null,
    extensions: {},
  });
}

describe("MCSF Alpha2 delta targeting", () => {
  it("rewrites only the session and workspace named by Canonical project/workspace changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-mcsf-alpha2-target-"));
    roots.push(root);
    const database = openMaintenanceDatabase(join(root, "metadata.sqlite"));
    databases.push(database);
    const canonical = new SqliteCanonicalRepository(database);
    await seed(canonical, "a");
    await seed(canonical, "b");

    let nextId = 0;
    const cache = new PersistentProjectionCache({
      runtimeRoot: join(root, "runtime"),
      source: new SqliteCanonicalProjectionSource(database),
      adapter,
      statusLog: new StatusLog(new MemoryStatusEventAdapter(), {
        clock: () => at,
        idFactory: (kind) => `${kind}-${++nextId}`,
      }),
      clock: () => at,
    });
    const baseline = await cache.apply({ run: run("baseline"), configuration: { branchId: "main" } });
    const nativeA = alpha2NativeSessionId("logical-a" as never);
    const nativeB = alpha2NativeSessionId("logical-b" as never);
    const sessionAPath = join(baseline.cacheRoot, "sessions", `${encoded(nativeA)}.json`);
    const sessionBPath = join(baseline.cacheRoot, "sessions", `${encoded(nativeB)}.json`);
    const workspaceAPath = join(baseline.cacheRoot, "workspaces", `${encoded("workspace-a")}.json`);
    const workspaceBPath = join(baseline.cacheRoot, "workspaces", `${encoded("workspace-b")}.json`);
    const before = {
      sessionA: (await stat(sessionAPath, { bigint: true })).mtimeNs,
      sessionB: (await stat(sessionBPath, { bigint: true })).mtimeNs,
      workspaceA: (await stat(workspaceAPath, { bigint: true })).mtimeNs,
      workspaceB: (await stat(workspaceBPath, { bigint: true })).mtimeNs,
    };

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    const changedAt = "2026-09-03T00:01:00.000Z";
    await canonical.upsertLogicalWorkspace({
      schemaVersion: 1,
      id: "workspace-a" as never,
      parentId: null,
      name: "Workspace A changed",
      sortKey: "a",
      deletedAt: null,
      createdAt: at,
      updatedAt: changedAt,
    });
    await canonical.upsertLogicalProject({
      schemaVersion: 1,
      id: "project-a" as never,
      name: "Project A changed",
      sourcePlatform: "maintenance",
      sourceProjectId: null,
      sortKey: "a",
      deletedAt: null,
      createdAt: at,
      updatedAt: changedAt,
    });
    await canonical.replaceProjectRoots("project-a" as never, [{
      schemaVersion: 1,
      projectId: "project-a" as never,
      path: "D:\\fixture\\project-a-changed",
      normalizedPath: "d:\\fixture\\project-a-changed",
      ordinal: 0,
    }]);

    const delta = await cache.apply({ run: run("delta"), configuration: { branchId: "main" } });
    expect(delta.receipt).toMatchObject({
      baseline: false,
      changedSessions: 1,
      rewrittenSessions: 1,
      rewrittenWorkspaces: 1,
      removedSessions: 0,
      removedWorkspaces: 0,
    });
    expect((await stat(sessionAPath, { bigint: true })).mtimeNs).toBeGreaterThan(before.sessionA);
    expect((await stat(workspaceAPath, { bigint: true })).mtimeNs).toBeGreaterThan(before.workspaceA);
    expect((await stat(sessionBPath, { bigint: true })).mtimeNs).toBe(before.sessionB);
    expect((await stat(workspaceBPath, { bigint: true })).mtimeNs).toBe(before.workspaceB);
  });
});
