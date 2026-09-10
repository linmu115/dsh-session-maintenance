import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue, ProjectionRun, ProjectionRunRepository } from "@linmu/dsh-session-contracts";
import { adapter, rc1NativeSessionCodec } from "../../adapter-dsh-rc1/src/index.js";
import { JsonProjectionDirectory, NativeSessionSpace, nativeSpaceReference } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function run(id: string): ProjectionRun {
  return { schemaVersion: 1, id: id as never, leaseId: `lease-${id}` as never, branchId: "main" as never,
    instanceId: "synthetic-rc1", profileId: "web", dshVersion: "0.1.2-rc.1", adapterId: "dsh-rc1" as never,
    state: "preparing", startedAt: "2026-09-10T00:00:00Z", heartbeatAt: "2026-09-10T00:00:00Z", checkpointId: null };
}
function payload(id: string, text = "synthetic"): JsonValue {
  return { schemaVersion: 1, logicalSessionId: id, baseVersionId: "v1", projectId: null, updatedAt: "2026-09-10T00:00:00Z",
    title: id, tags: [], inheritedEventCount: 0,
    header: { version: 0, id, createdAt: 1, delegationDepth: 0, isSeeded: false },
    events: text ? [{ type: "user/message", seq: 0, time: 2, data: { role: "user", content: [{ type: "text", text }] }, surfaceOp: "append" }] : [] };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-native-space-synthetic-")); roots.push(root);
  const states = new Map<string, ProjectionRun>();
  const repository = { getProjectionRun: async (id: string) => states.get(id) } as ProjectionRunRepository;
  const directory = new JsonProjectionDirectory(join(root, "projection")); await directory.initialize();
  const setup = async (r: ProjectionRun, data: Record<string, JsonValue>) => {
    for (const id of await directory.listNativeSessionIds()) if (!(id in data)) await directory.removeSession(id);
    for (const [id, value] of Object.entries(data)) await directory.replaceSession(id as never, value);
    const inspected = await adapter.inspect(directory);
    await directory.replaceManifest({ schemaVersion: 1, runId: r.id, adapterId: adapter.manifest.id,
      sessionCount: inspected.sessionCount, workspaceCount: 0, catalogDigest: inspected.catalogDigest, sessionDigests: inspected.sessionDigests });
    await directory.rebuildSessionCatalog(r.id);
    states.set(r.id, r);
  };
  return { root, states, repository, directory, setup };
}

describe("persistent native session space", () => {
  it("N01/N02/N03: materializes all 205 sessions, retains unchanged files, updates only changed content", async () => {
    const f = await fixture(); const first = run("run-one");
    const data = Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`s${i}`, payload(`s${i}`)]));
    await f.setup(first, data);
    const space = new NativeSessionSpace(f.root, first, adapter, f.repository);
    await space.prepare(f.directory);
    const artifacts = await rc1NativeSessionCodec.inspect(space.reference.root);
    expect(artifacts).toHaveLength(205);
    const tail = artifacts.find(a => a.nativeSessionId === "s204")!;
    const file = join(space.reference.root, tail.relativePath); const before = await stat(file, { bigint: true });
    await space.checkpoint(f.directory); f.states.set(first.id, { ...first, state: "closed" });
    const second = run("run-two"); await f.setup(second, data);
    const read = vi.spyOn(f.directory, "readSession");
    const next = new NativeSessionSpace(f.root, second, adapter, f.repository); await next.prepare(f.directory);
    expect(next.reference.root).toBe(space.reference.root);
    expect(read).not.toHaveBeenCalled();
    expect((await stat(file, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
    await next.checkpoint(f.directory); f.states.set(second.id, { ...second, state: "closed" });
    const third = run("run-three"); await f.setup(third, { ...data, s0: payload("s0", "changed") }); read.mockClear();
    await new NativeSessionSpace(f.root, third, adapter, f.repository).prepare(f.directory);
    expect(read.mock.calls.map(c => c[0])).toEqual(["s0"]);
    expect((await stat(file, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
  }, 60_000);

  it("N04/N05: deletes and restores records, including genuine empty files and moved cwd", async () => {
    const f = await fixture(); const first = run("first"); await f.setup(first, { a: payload("a", ""), b: payload("b") });
    const s = new NativeSessionSpace(f.root, first, adapter, f.repository); await s.prepare(f.directory);
    expect((await rc1NativeSessionCodec.inspect(s.reference.root)).find(a => a.nativeSessionId === "a")?.events).toEqual([]);
    await s.checkpoint(f.directory); f.states.set(first.id, { ...first, state: "closed" });
    const second = run("second"); const moved = payload("b") as Record<string, JsonValue>;
    moved.header = { ...(moved.header as object), cwd: f.root } as JsonValue;
    await f.setup(second, { b: moved }); const n = new NativeSessionSpace(f.root, second, adapter, f.repository); await n.prepare(f.directory);
    const artifacts = await rc1NativeSessionCodec.inspect(n.reference.root); expect(artifacts).toHaveLength(1);
    expect((artifacts[0]!.header as Record<string, JsonValue>).cwd).toBe(f.root);
    await n.checkpoint(f.directory); f.states.set(second.id, { ...second, state: "closed" });
    const third = run("third"); await f.setup(third, { a: payload("a", ""), b: moved });
    await new NativeSessionSpace(f.root, third, adapter, f.repository).prepare(f.directory);
    expect(await rc1NativeSessionCodec.inspect(n.reference.root)).toHaveLength(2);
  });

  it("N09/N10: refuses active ownership, changed native bytes, and isolates instance/profile/format", async () => {
    const f = await fixture(); const first = run("one"); await f.setup(first, { a: payload("a") });
    const s = new NativeSessionSpace(f.root, first, adapter, f.repository); await s.prepare(f.directory);
    await expect(new NativeSessionSpace(f.root, run("two"), adapter, f.repository).prepare(f.directory)).rejects.toThrow(/safely closed/);
    expect(nativeSpaceReference(f.root, { ...first, profileId: "other" }, rc1NativeSessionCodec).root).not.toBe(s.reference.root);
    expect(nativeSpaceReference(f.root, { ...first, instanceId: "other" }, rc1NativeSessionCodec).root).not.toBe(s.reference.root);
    expect(nativeSpaceReference(f.root, first, { ...rc1NativeSessionCodec, formatId: "other" }).root).not.toBe(s.reference.root);
    await s.checkpoint(f.directory); f.states.set(first.id, { ...first, state: "closed" });
    const [artifact] = await rc1NativeSessionCodec.inspect(s.reference.root);
    await appendFile(join(s.reference.root, artifact!.relativePath), "changed");
    await f.setup(run("two"), { a: payload("a") });
    await expect(new NativeSessionSpace(f.root, run("two"), adapter, f.repository).prepare(f.directory)).rejects.toThrow(/changed after checkpoint/);
  });

  it("N08: completes an interrupted replacement from its journal before the next preparation", async () => {
    const f = await fixture(); const r = run("interrupted"); await f.setup(r, { a: payload("a") });
    const s = new NativeSessionSpace(f.root, r, adapter, f.repository); await s.prepare(f.directory);
    // Reconstruct a post-rename/pre-manifest-commit journal using a known synthetic artifact.
    const manifestPath = join(dirname(s.reference.root), "space.json");
    const m = { ...JSON.parse(await readFile(manifestPath, "utf8")), state: "preparing" };
    const { createHash } = await import("node:crypto");
    const state = m.files.a; const bytes = await readFile(join(s.reference.root, state.path));
    await writeFile(join(dirname(s.reference.root), "sync.json"), JSON.stringify({ schemaVersion: 1, next: m,
      replacements: [{ path: state.path, staged: "00000000.native", hash: createHash("sha256").update(bytes).digest("hex"), previous: null }], deletions: [] }));
    f.states.set(r.id, { ...r, state: "quarantined" });
    const next = run("after-interruption"); await f.setup(next, { a: payload("a") });
    await new NativeSessionSpace(f.root, next, adapter, f.repository).prepare(f.directory);
    expect(await rc1NativeSessionCodec.inspect(s.reference.root)).toHaveLength(1);
    await expect(readFile(join(dirname(s.reference.root), "sync.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("N08: recovers failure after journal commit but before catalog publication and removes orphan staging", async () => {
    const f = await fixture(); const r = run("publication-failure"); await f.setup(r, { a: payload("a") });
    const s = new NativeSessionSpace(f.root, r, adapter, f.repository);
    const publish = vi.spyOn(f.directory, "replaceSessionCatalog").mockRejectedValueOnce(new Error("synthetic publication failure"));
    await expect(s.prepare(f.directory)).rejects.toThrow("publication failure");
    publish.mockRestore();
    await writeFile(join(dirname(s.reference.root), "aaaaaaaa.native"), "unpublished synthetic staging");
    await s.recoverPreparation(f.directory);
    expect(await rc1NativeSessionCodec.inspect(s.reference.root)).toHaveLength(1);
    await expect(readFile(join(dirname(s.reference.root), "aaaaaaaa.native"))).rejects.toMatchObject({ code: "ENOENT" });
    await s.checkpoint(f.directory); f.states.set(r.id, { ...r, state: "closed" });
    await writeFile(join(s.reference.root, "unknown-user-file"), "must remain untouched");
    await expect(new NativeSessionSpace(f.root, run("next"), adapter, f.repository).prepare(f.directory)).rejects.toThrow("unowned native");
    expect(await readFile(join(s.reference.root, "unknown-user-file"), "utf8")).toBe("must remain untouched");
  });
});
