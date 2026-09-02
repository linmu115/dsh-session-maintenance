import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createReadOnlyTestSystem, hashTree } from "./helpers/read-only-system.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("discovery idempotence", () => {
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
