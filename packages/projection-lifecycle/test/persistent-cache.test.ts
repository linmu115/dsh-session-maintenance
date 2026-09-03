import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type {
  CanonicalChangePage,
  CanonicalChangeQuery,
  CanonicalChangeV1,
  CanonicalProjectionInput,
  CanonicalProjectionSessionInput,
  ProjectionRun,
} from "@linmu/dsh-session-contracts";
import { adapter, alpha2NativeSessionId } from "@linmu/dsh-session-adapter-alpha2";
import { MemoryStatusEventAdapter, StatusLog } from "@linmu/dsh-session-status-log";

import {
  JsonProjectionDirectory,
  PersistentProjectionCache,
  type IncrementalCanonicalProjectionSource,
} from "../src/index.js";

const roots: string[] = [];
const at = "2026-09-03T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function run(id: string): ProjectionRun {
  return {
    schemaVersion: 1,
    id: id as never,
    leaseId: `lease-${id}` as never,
    branchId: "main" as never,
    instanceId: "alpha2-fixture",
    profileId: "web",
    dshVersion: "0.1.2-alpha.2",
    adapterId: adapter.manifest.id,
    state: "preparing",
    startedAt: at,
    heartbeatAt: at,
    checkpointId: null,
  };
}

function session(id: string, title: string, updatedAt = at): CanonicalProjectionSessionInput {
  return {
    session: {
      schemaVersion: 1,
      id: id as never,
      authorityScope: "maintenance",
      originKind: "maintenance-native",
      headVersionId: null,
      title,
      tags: [],
      archivedAt: null,
      tombstonedAt: null,
      createdAt: at,
      updatedAt,
    },
    events: [],
    workspaceId: null,
    projectId: null,
    projectName: null,
    projectRoot: null,
  };
}

class MutableSource implements IncrementalCanonicalProjectionSource {
  revision = 2;
  sessions = new Map<string, CanonicalProjectionSessionInput>([
    ["logical-a", session("logical-a", "A")],
    ["logical-b", session("logical-b", "B")],
  ]);
  changes: CanonicalChangeV1[] = [
    { schemaVersion: 1, revision: 1, logicalSessionId: "logical-a" as never, kind: "session-created", changedAt: at },
    { schemaVersion: 1, revision: 2, logicalSessionId: "logical-b" as never, kind: "session-created", changedAt: at },
  ];
  loadedBatches: string[][] = [];

  async currentRevision(): Promise<number> { return this.revision; }

  async load(runInput: ProjectionRun): Promise<CanonicalProjectionInput> {
    this.loadedBatches.push([...this.sessions.keys()]);
    return { run: runInput, workspaces: [], sessions: [...this.sessions.values()] };
  }

  async loadSessions(runInput: ProjectionRun, ids: readonly string[]): Promise<CanonicalProjectionInput> {
    this.loadedBatches.push([...ids]);
    return {
      run: runInput,
      workspaces: [],
      sessions: ids.flatMap((id) => {
        const value = this.sessions.get(id);
        return value === undefined ? [] : [value];
      }),
    };
  }

  async listChanges(query: CanonicalChangeQuery): Promise<CanonicalChangePage> {
    const changes = this.changes.filter((change) => change.revision > query.afterRevision).slice(0, query.limit);
    const throughRevision = changes.at(-1)?.revision ?? query.afterRevision;
    return {
      schemaVersion: 1,
      afterRevision: query.afterRevision,
      throughRevision,
      currentRevision: this.revision,
      hasMore: throughRevision < this.revision,
      changes,
    };
  }
}

function sessionFile(root: string, logicalSessionId: string): string {
  const native = alpha2NativeSessionId(logicalSessionId as never);
  return join(root, "sessions", `${Buffer.from(native, "utf8").toString("base64url")}.json`);
}

describe("persistent projection cache", () => {
  it("builds once, performs zero body writes without changes, then updates only affected sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-persistent-cache-"));
    roots.push(root);
    const source = new MutableSource();
    const statusAdapter = new MemoryStatusEventAdapter();
    let id = 0;
    const cache = new PersistentProjectionCache({
      runtimeRoot: root,
      source,
      adapter,
      statusLog: new StatusLog(statusAdapter, {
        clock: () => at,
        idFactory: (kind) => `${kind}-${++id}`,
      }),
      clock: () => at,
    });
    const configuration = { branchId: "main" } as const;

    const baseline = await cache.apply({ run: run("run-cache-1"), configuration });
    expect(baseline.receipt).toMatchObject({ baseline: true, fromRevision: 0, throughRevision: 2, rewrittenSessions: 2, removedSessions: 0 });
    expect(baseline.cacheManifest.sessions[0]).toMatchObject({
      logicalSessionId: "logical-a",
      title: "A",
      authorityScope: "maintenance",
      nativeRevision: 0,
    });
    expect(baseline.cacheManifest.sessions[0]).not.toHaveProperty("events");
    const aPath = sessionFile(baseline.cacheRoot, "logical-a");
    const bPath = sessionFile(baseline.cacheRoot, "logical-b");
    const initialA = (await stat(aPath, { bigint: true })).mtimeNs;
    const initialB = (await stat(bPath, { bigint: true })).mtimeNs;

    const noChanges = await cache.apply({ run: run("run-cache-2"), configuration });
    expect(noChanges.cacheRoot).toBe(baseline.cacheRoot);
    expect(noChanges.receipt).toMatchObject({ baseline: false, fromRevision: 2, throughRevision: 2, changedSessions: 0, rewrittenSessions: 0, removedSessions: 0 });
    expect((await stat(aPath, { bigint: true })).mtimeNs).toBe(initialA);
    expect((await stat(bPath, { bigint: true })).mtimeNs).toBe(initialB);
    expect(source.loadedBatches).toEqual([["logical-a", "logical-b"]]);

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    source.revision = 3;
    source.sessions.set("logical-a", session("logical-a", "A changed", "2026-09-03T00:01:00.000Z"));
    source.changes.push({ schemaVersion: 1, revision: 3, logicalSessionId: "logical-a" as never, kind: "metadata-updated", changedAt: "2026-09-03T00:01:00.000Z" });
    const changed = await cache.apply({ run: run("run-cache-3"), configuration });
    expect(changed.receipt).toMatchObject({ fromRevision: 2, throughRevision: 3, changedSessions: 1, rewrittenSessions: 1, removedSessions: 0 });
    expect((await stat(aPath, { bigint: true })).mtimeNs).toBeGreaterThan(initialA);
    expect((await stat(bPath, { bigint: true })).mtimeNs).toBe(initialB);
    expect(source.loadedBatches.at(-1)).toEqual(["logical-a"]);

    source.revision = 4;
    source.sessions.delete("logical-b");
    source.changes.push({ schemaVersion: 1, revision: 4, logicalSessionId: "logical-b" as never, kind: "tombstone-updated", changedAt: "2026-09-03T00:02:00.000Z" });
    const removed = await cache.apply({ run: run("run-cache-4"), configuration });
    expect(removed.receipt).toMatchObject({ fromRevision: 3, throughRevision: 4, changedSessions: 1, rewrittenSessions: 0, removedSessions: 1 });
    await expect(stat(bPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await new JsonProjectionDirectory(removed.cacheRoot).listNativeSessionIds()).toEqual([
      alpha2NativeSessionId("logical-a" as never),
    ]);

    const statuses = await statusAdapter.list({ stage: "projection.delta-apply", limit: 100 });
    expect(statuses.items.filter((event) => event.state === "started")).toHaveLength(4);
    expect(statuses.items.filter((event) => event.state === "succeeded")).toHaveLength(4);
    expect(new Set(statuses.items.map((event) => event.spanId)).size).toBe(4);
    expect(JSON.stringify(statuses.items)).not.toContain("A changed");
  });

  it("separates projection configurations and rebuilds the same format-family cache after an Adapter upgrade", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-persistent-cache-identity-"));
    roots.push(root);
    const source = new MutableSource();
    const statusAdapter = new MemoryStatusEventAdapter();
    let id = 0;
    const statusLog = new StatusLog(statusAdapter, {
      clock: () => at,
      idFactory: (kind) => `${kind}-${++id}`,
    });
    const firstManager = new PersistentProjectionCache({ runtimeRoot: root, source, adapter, statusLog, clock: () => at });
    const first = await firstManager.apply({ run: run("run-identity-1"), configuration: { branchId: "main" } });
    const otherConfiguration = await firstManager.apply({ run: run("run-identity-2"), configuration: { branchId: "experiment" } });
    expect(otherConfiguration.cacheRoot).not.toBe(first.cacheRoot);

    const upgradedAdapter = {
      ...adapter,
      manifest: { ...adapter.manifest, packageVersion: "0.1.1" },
    };
    const upgradedManager = new PersistentProjectionCache({
      runtimeRoot: root,
      source,
      adapter: upgradedAdapter,
      statusLog,
      clock: () => "2026-09-03T00:10:00.000Z",
    });
    const rebuilt = await upgradedManager.apply({ run: run("run-identity-3"), configuration: { branchId: "main" } });
    expect(rebuilt.cacheRoot).toBe(first.cacheRoot);
    expect(rebuilt.receipt.baseline).toBe(true);
    expect(rebuilt.cacheManifest.adapterFingerprint).not.toBe(first.cacheManifest.adapterFingerprint);
  });
});
