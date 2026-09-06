import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DiscoveryService } from "../../packages/session-domain/src/index.js";

import { createReadOnlyTestSystem, hashTree } from "./helpers/read-only-system.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("discovery idempotence", () => {
  it("keeps an in-flight scan snapshot while later scans see newly registered sources", async () => {
    const system = await createReadOnlyTestSystem();
    cleanups.push(system.cleanup);
    const before = await Promise.all(system.platformRoots.map(hashTree));
    const instances = [...system.instances];
    const discovery = new DiscoveryService({ instances, adapters: system.adapters, repository: system.repository, objectStore: system.objectStore });
    let entered!: () => void;
    const scanning = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const adapter = system.adapters[0]!;
    const probe = adapter.probe.bind(adapter);
    vi.spyOn(adapter, "probe").mockImplementationOnce(async instance => {
      entered();
      await blocked;
      return probe(instance);
    });
    const firstScan = discovery.scanAll();
    await scanning;
    // Onboarding updates the shared array while an earlier batch is already in progress.
    instances.splice(1, 1, { ...instances[0]!, id: "codex-new-source" });
    release();
    expect(await firstScan).toMatchObject({ createdLogicalSessions: 2, createdBindings: 2, platformWrites: 0 });
    expect(await system.repository.findBinding({ platform: "dsh", instanceId: "dsh-fixture", sessionId: "dsh-session-1" })).toBeDefined();
    await expect(discovery.scanInstance("dsh-fixture")).rejects.toThrow("Unknown instance");
    expect(await discovery.scanAll()).toMatchObject({ createdLogicalSessions: 1, createdBindings: 1, platformWrites: 0 });
    expect(await discovery.scanInstance("codex-new-source")).toMatchObject({ createdLogicalSessions: 0, createdBindings: 0, createdVersions: 0, platformWrites: 0 });
    expect(await Promise.all(system.platformRoots.map(hashTree))).toEqual(before);
  });

  it("creates one immutable baseline per platform and nothing on the second scan", async () => {
    const system = await createReadOnlyTestSystem();
    cleanups.push(system.cleanup);
    const before = await Promise.all(system.platformRoots.map(hashTree));

    const first = await system.discovery.scanAll();
    const counts = await system.repository.counts();
    const second = await system.discovery.scanAll();

    expect(first).toMatchObject({
      createdLogicalSessions: 2,
      createdBindings: 2,
      createdVersions: 2,
      platformWrites: 0,
    });
    expect(second).toEqual({
      createdLogicalSessions: 0,
      createdBindings: 0,
      createdVersions: 0,
      createdCandidates: 0,
      skippedSessions: 0,
      platformWrites: 0,
    });
    expect(await system.repository.counts()).toEqual(counts);
    expect(first.platformWrites + second.platformWrites).toBe(0);
    expect(await Promise.all(system.platformRoots.map(hashTree))).toEqual(before);

    const canonical = system.repository.database
      .prepare("SELECT canonical_version_id FROM logical_sessions")
      .all() as unknown as Array<{ readonly canonical_version_id: string | null }>;
    expect(canonical.every((row) => row.canonical_version_id === null)).toBe(true);
  });

  it("creates a metadata-only child version after a title change", async () => {
    const system = await createReadOnlyTestSystem();
    cleanups.push(system.cleanup);
    await system.discovery.scanInstance("codex-fixture");

    const database = new DatabaseSync(
      `${system.sandbox.codexHome}\\state_5.sqlite`,
    );
    database
      .prepare("UPDATE threads SET name = ?, title = ?, updated_at = ? WHERE id = ?")
      .run("Renamed fixture", "Renamed fixture", "2026-08-26T00:00:03.000Z", "thread-fixture");
    database.close();

    const changed = await system.discovery.scanInstance("codex-fixture");
    expect(changed).toMatchObject({ createdVersions: 1, createdBindings: 0, platformWrites: 0 });
    const sessions = await system.repository.listSessions({ limit: 10 });
    const graph = await system.repository.getGraph(sessions.items[0]!.logicalSessionId);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes.find((node) => node.parents.length === 1)).toBeDefined();
  });
});
