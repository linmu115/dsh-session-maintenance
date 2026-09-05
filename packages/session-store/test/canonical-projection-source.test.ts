import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CanonicalSessionEngine } from "@linmu/dsh-canonical-session-engine";
import type { CanonicalEventV1, IncrementalCanonicalProjectionSource, LogicalSessionId, ProjectionRun } from "@linmu/dsh-session-contracts";
import {
  openMaintenanceDatabase,
  SqliteCanonicalProjectionSource,
  SqliteCanonicalRepository,
  SqliteCanonicalSessionEngineStore,
  ZstdContentObjectStore,
} from "../src/index.js";

const roots: string[] = [];
const databases: ReturnType<typeof openMaintenanceDatabase>[] = [];
const at = "2026-09-05T00:00:00.000Z";
const run: ProjectionRun = {
  schemaVersion: 1, id: "run-source-fixture" as never, leaseId: "lease-fixture" as never,
  branchId: "main" as never, instanceId: "fixture", profileId: "fixture", dshVersion: "0.1.2-alpha.2",
  adapterId: "dsh-alpha2" as never, state: "preparing", startedAt: at, heartbeatAt: at, checkpointId: null,
};

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-sm-projection-source-fixture-"));
  roots.push(root);
  await writeFile(join(root, ".synthetic-fixture"), "SM-04 synthetic source test\n");
  const database = openMaintenanceDatabase(join(root, "metadata.sqlite"));
  databases.push(database);
  const objectStore = new ZstdContentObjectStore(root);
  const repository = new SqliteCanonicalRepository(database);
  const engine = new CanonicalSessionEngine(new SqliteCanonicalSessionEngineStore(database, objectStore));
  const source: IncrementalCanonicalProjectionSource = new SqliteCanonicalProjectionSource(database, objectStore);
  return { database, objectStore, repository, engine, source };
}

function event(logicalSessionId: LogicalSessionId): CanonicalEventV1 {
  return {
    schemaVersion: 1, id: `event-${logicalSessionId}`, logicalSessionId, sequence: 0,
    kind: "user-message", role: "user", content: { text: "synthetic message" },
    source: { platform: "codex", instanceId: "fixture", sessionId: "fixture", eventId: "0", cursor: "0" },
    contentDigest: "sha256:synthetic", rawPayload: null, extensions: {},
  };
}

async function observe(engine: CanonicalSessionEngine, id: string) {
  const logicalSessionId = id as LogicalSessionId;
  return engine.observeCodex({
    logicalSessionId, title: id, tags: ["fixture"], archivedAt: null, workspaceId: null,
    events: [event(logicalSessionId)], sourceCursor: "fixture", observedAt: at,
  });
}

describe("Store canonical projection source", () => {
  it("reads immutable head bodies while the optional index-only source retains its fallback", async () => {
    const { database, engine, source } = await fixture();
    const id = "source-head" as LogicalSessionId;
    await observe(engine, id);
    const fallback = new SqliteCanonicalProjectionSource(database);
    expect((await source.load(run)).sessions[0]?.events).toEqual([event(id)]);
    expect(await fallback.load(run)).toEqual(await source.load(run));
    database.prepare("DELETE FROM canonical_events WHERE logical_session_id = ?").run(id);
    expect((await source.load(run)).sessions[0]?.events).toEqual([event(id)]);
    expect((await fallback.load(run)).sessions[0]?.events).toEqual([]);
    await engine.retitleCodexMirror({ logicalSessionId: id, title: "Current title", appliedAt: at });
    expect((await source.load(run)).sessions[0]?.session).toMatchObject({ title: "Current title", tags: ["fixture"] });
  });

  it("preserves grouping and tombstone filtering for full, partial and empty selections", async () => {
    const { database, engine, source, repository } = await fixture();
    const id = "source-grouped" as LogicalSessionId;
    await observe(engine, id);
    await observe(engine, "source-hidden");
    const workspaceId = "workspace-source" as never;
    const projectId = "project-source" as never;
    await repository.upsertLogicalWorkspace({
      schemaVersion: 1, id: workspaceId, parentId: null, name: "Workspace", sortKey: "1",
      deletedAt: null, createdAt: at, updatedAt: at,
    });
    await repository.setWorkspaceMembership({ schemaVersion: 1, logicalSessionId: id, workspaceId,
      displayOrder: 0, pinned: false, archived: false, revision: 0 });
    await repository.upsertLogicalProject({ schemaVersion: 1, id: projectId, name: "Project",
      sourcePlatform: "maintenance", sourceProjectId: null, sortKey: "1", deletedAt: null, createdAt: at, updatedAt: at });
    await repository.replaceProjectRoots(projectId, [
      { schemaVersion: 1, projectId, path: "D:/synthetic/second", normalizedPath: "d:/synthetic/second", ordinal: 1 },
      { schemaVersion: 1, projectId, path: "D:/synthetic/first", normalizedPath: "d:/synthetic/first", ordinal: 0 },
    ]);
    await repository.setProjectMembership({ schemaVersion: 1, logicalSessionId: id, projectId, revision: 0 });
    database.prepare("UPDATE logical_sessions SET tombstoned_at = ? WHERE id = ?").run(at, "source-hidden");
    const full = await source.load(run);
    expect(full.sessions).toHaveLength(1);
    expect(full.sessions[0]).toMatchObject({ workspaceId, projectId, projectName: "Project", projectRoot: "D:/synthetic/first" });
    expect(await source.loadSessions(run, [id, "source-hidden" as LogicalSessionId])).toEqual(full);
    expect(await source.loadSessions(run, [])).toEqual({ run, workspaces: full.workspaces, sessions: [] });
    expect(await source.loadSessions(run, ["missing" as LogicalSessionId])).toEqual({ run, workspaces: full.workspaces, sessions: [] });
    database.prepare("UPDATE logical_workspaces SET deleted_at = ? WHERE id = ?").run(at, workspaceId);
    database.prepare("UPDATE logical_projects SET deleted_at = ? WHERE id = ?").run(at, projectId);
    const deletedGroups = await source.load(run);
    expect(deletedGroups.workspaces).toEqual([]);
    expect(deletedGroups.sessions[0]).toMatchObject({ workspaceId: null, projectId: null, projectName: null, projectRoot: null });
  });

  it("pages the same journal as the canonical repository and rejects invalid or future cursors", async () => {
    const { engine, source, repository } = await fixture();
    expect(await source.currentRevision()).toBe(0);
    await observe(engine, "source-cursor-a");
    await observe(engine, "source-cursor-b");
    let cursor = 0;
    const revisions: number[] = [];
    do {
      const query = { afterRevision: cursor, limit: 1 };
      const page = await source.listChanges(query);
      expect(page).toEqual(await repository.listChanges(query));
      revisions.push(...page.changes.map((change) => change.revision));
      cursor = page.throughRevision;
      if (!page.hasMore) break;
    } while (true);
    expect(revisions).toEqual(Array.from({ length: await source.currentRevision() }, (_, index) => index + 1));
    expect(await source.listChanges({ afterRevision: cursor, limit: 1 })).toMatchObject({ changes: [], hasMore: false });
    await expect(source.listChanges({ afterRevision: cursor + 1, limit: 1 })).rejects.toThrow("exceeds current revision");
    await expect(source.listChanges({ afterRevision: -1, limit: 1 })).rejects.toThrow();
    await expect(source.listChanges({ afterRevision: 0, limit: 0 })).rejects.toThrow();
  });

  it("rejects a missing head record and invalid object schema instead of falling back silently", async () => {
    const { database, engine, source } = await fixture();
    await observe(engine, "source-invalid");
    const invalidSource = new SqliteCanonicalProjectionSource(database, {
      get: async () => Buffer.from(JSON.stringify({ schemaVersion: 99, events: [] })),
    } as never);
    await expect(invalidSource.load(run)).rejects.toThrow("Canonical projection body is invalid");
    const foreign = await observe(engine, "source-other-owner");
    database.prepare("UPDATE logical_sessions SET head_version_id = ? WHERE id = ?").run(foreign.versionId, "source-invalid");
    await expect(source.load(run)).rejects.toThrow("Canonical projection head is missing");
  });
});
