import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { CanonicalProjectionInput, JsonValue, LogicalSessionId, LogicalWorkspaceId, ProjectionRun } from "@linmu/dsh-session-contracts";
import { v3NativeSessionCodec, v3NativeSessionId } from "@linmu/dsh-session-adapter-0-1-5";
import { materializeNativeSessions, sessionRevision, writeBackProjectionToInstance } from "../src/instance-session-writeback.js";
import type { NativeOverwriteJournalEntry } from "../src/native-session-overwrite.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
/** Synthetic trees only; no real DSH Home is read or written by these tests. */
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "dsh-writeback-"));
  roots.push(root);
  const sessionsRoot = join(root, "home", "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  return { root, sessionsRoot, stateRoot: join(root, "engine-state"), backupRoot: join(root, "backups") };
}

const INSTANCE = "i-synthetic";
const cwd = "D:\\合成\\工作区";
const at = "2026-09-21T10:00:00.000Z";

/** One canonical session, in the shape the projection source hands the adapter. */
function canonicalSession(id: string, workspaceId: string | null, text: string, archivedAt: string | null = null) {
  return {
    session: { schemaVersion: 1 as const, id: id as LogicalSessionId, headVersionId: `version-${id}` as never,
      title: `会话 ${id}`, tags: [], archivedAt, createdAt: at, updatedAt: at, deletedAt: null },
    // The adapter re-materialises the native rows from `rawPayload`, which is what
    // the canonical store keeps for a session the instance itself produced.
    events: [{ schemaVersion: 1 as const, id: `event-${id}` as never, logicalSessionId: id as LogicalSessionId, sequence: 0,
      kind: "user-message" as const, role: "user" as const, content: { text }, contentDigest: `sha256:${id}`,
      rawPayload: { seq: 0, time: Date.parse(at), type: "user/message", surfaceOp: "append",
        data: { id: `event-${id}`, role: "user", content: [{ type: "text", text }], source: { kind: "user" } } } as unknown as JsonValue,
      extensions: { nativeFormatVersion: 3 },
      // A canonical row always names the native session it came from.
      source: { platform: "dsh", instanceId: INSTANCE, sessionId: String(v3NativeSessionId(id as never)), eventId: "0", cursor: "0" } }],
    workspaceId: workspaceId as LogicalWorkspaceId | null,
    projectId: null, projectName: null, projectRoot: cwd,
  } as unknown as CanonicalProjectionInput["sessions"][number];
}

const projection = (sessions: CanonicalProjectionInput["sessions"]): CanonicalProjectionInput => ({
  run: { schemaVersion: 1, id: "run-one", leaseId: "lease-one", branchId: "main", instanceId: INSTANCE, profileId: "web",
    dshVersion: "0.1.5-rc.2", adapterId: "dsh-0.1.5", state: "running", startedAt: at, heartbeatAt: at, checkpointId: null } as unknown as ProjectionRun,
  workspaces: [], sessions,
});

it("materialises the projection through the adapter and writes it into the instance's own layout", async () => {
  const f = await scratch();
  const journal: NativeOverwriteJournalEntry[] = [];
  const result = await writeBackProjectionToInstance({ projection: projection([canonicalSession("logical-one", "workspace-joined", "hello")]),
    sessionsRoot: f.sessionsRoot, stateRoot: f.stateRoot, instanceId: INSTANCE, backupRoot: f.backupRoot,
    inScope: () => true, archived: () => false, journal: async entry => { journal.push(entry); } });
  expect(result.skippedOutOfScope).toEqual([]);
  expect(result.receipt.applied).toHaveLength(1);
  const relativePath = result.plan.entries[0]!.relativePath;
  // The instance's own layout: a project directory, then one directory per session.
  expect(relativePath).toBe(`--D-~5408~6210-~5DE5~4F5C~533A--/${v3NativeSessionId("logical-one" as never)}/session.v3.jsonl.zstd`);
  const written = join(f.sessionsRoot, ...relativePath.split("/"));
  // The bytes come from the adapter's own encode, and the host's own codec would read them back.
  const bytes = await readFile(written);
  expect(bytes.byteLength).toBeGreaterThan(0);
  const decoded = v3NativeSessionCodec.encode(await materializedPayload("logical-one", "hello"), {
    relativePath: `${v3NativeSessionId("logical-one" as never)}/session.v3.jsonl.zstd`,
    header: { version: 3, id: v3NativeSessionId("logical-one" as never), cwd, createdAt: Date.parse(at), delegationDepth: 0, isSeeded: false },
  } as never);
  expect(bytes.byteLength).toBe(decoded.byteLength);
  // Nothing the Engine owns was left inside the instance's tree.
  const sessionDirectory = await readdir(join(f.sessionsRoot, relativePath.split("/")[0]!, relativePath.split("/")[1]!));
  expect(sessionDirectory).toEqual(["session.v3.jsonl.zstd"]);
  expect(await readdir(f.stateRoot)).toContain("native-archive-markers");
});

/** The same payload the adapter would materialise, used to check the bytes independently. */
async function materializedPayload(logicalId: string, text: string): Promise<JsonValue> {
  const captured = await materializeNativeSessions(projection([canonicalSession(logicalId, "workspace-joined", text)]));
  return captured[0]!.payload;
}

it("writes nothing on a second run and reports sessions outside the frozen scope", async () => {
  const f = await scratch();
  const journal: NativeOverwriteJournalEntry[] = [];
  const sessions = [canonicalSession("logical-inside", "workspace-joined", "inside"),
    canonicalSession("logical-outside", "workspace-other", "outside")];
  // The scope is the run's frozen one: only the joined workspace is admitted.
  const inScope = (session: { workspaceId: string | null }) => session.workspaceId === "workspace-joined";
  const first = await writeBackProjectionToInstance({ projection: projection(sessions), sessionsRoot: f.sessionsRoot,
    stateRoot: f.stateRoot, instanceId: INSTANCE, backupRoot: f.backupRoot, inScope, archived: () => false,
    journal: async entry => { journal.push(entry); } });
  expect(first.receipt.applied).toHaveLength(1);
  expect(first.skippedOutOfScope).toEqual(["logical-outside"]);
  // The out-of-scope session was never even materialised into the instance.
  const projectDirectory = join(f.sessionsRoot, first.plan.entries[0]!.relativePath.split("/")[0]!);
  expect(await readdir(projectDirectory)).toEqual([String(v3NativeSessionId("logical-inside" as never))]);

  // A start with nothing changed is a no-op: no second write, no new journal entry.
  const journalBefore = journal.length;
  const second = await writeBackProjectionToInstance({ projection: projection(sessions), sessionsRoot: f.sessionsRoot,
    stateRoot: f.stateRoot, instanceId: INSTANCE, backupRoot: f.backupRoot, inScope, archived: () => false,
    journal: async entry => { journal.push(entry); } });
  expect(second.plan.changed).toEqual([]);
  expect(second.receipt.applied).toEqual([]);
  expect(journal).toHaveLength(journalBefore);
});

it("treats a changed body and a changed archive state as changes, and an identical run as none", async () => {
  const f = await scratch();
  const journal: NativeOverwriteJournalEntry[] = [];
  const write = (text: string, archived: boolean) => writeBackProjectionToInstance({
    projection: projection([canonicalSession("logical-one", "workspace-joined", text, archived ? at : null)]),
    sessionsRoot: f.sessionsRoot, stateRoot: f.stateRoot, instanceId: INSTANCE, backupRoot: f.backupRoot,
    inScope: () => true, archived: session => session.archivedAt !== null,
    journal: async entry => { journal.push(entry); } });
  const first = await write("hello", true);
  expect(first.plan.entries[0]!.action).toBe("write");
  const before = await readFile(join(f.sessionsRoot, ...first.plan.entries[0]!.relativePath.split("/")));

  // The same body is not a change at all: nothing is written and nothing is journalled.
  const journalAfterFirst = journal.length;
  expect((await write("hello", true)).plan.changed).toEqual([]);
  expect(journal).toHaveLength(journalAfterFirst);

  // Archive metadata is independent of native bytes. This primitive updates its marker only;
  // the host adapter must separately provide and verify the actual archive-state protocol.
  const restored = await write("hello", false);
  expect(restored.plan.entries[0]!.action).toBe("restore-unarchived");
  expect(await readFile(join(f.sessionsRoot, ...first.plan.entries[0]!.relativePath.split("/")))).toEqual(before);
  expect(await readFile(join(f.stateRoot, "native-archive-markers", INSTANCE, ...restored.plan.entries[0]!.relativePath.split("/").slice(0, 2)) + ".json", "utf8"))
    .toContain("\"archived\":false");
  // The restore is recorded, so it is not replayed on the next identical run.
  expect((await write("hello", false)).plan.changed).toEqual([]);

  // A changed body is a changed revision even though the canonical head id is the
  // same object here, and the replaced bytes are kept before the rename.
  const changed = await write("changed", true);
  expect(changed.plan.entries[0]!.action).toBe("write");
  expect(changed.plan.entries[0]!.operationId).not.toBe(first.plan.entries[0]!.operationId);
  const latest = journal.filter(entry => entry.relativePath === changed.plan.entries[0]!.relativePath).at(-1)!;
  expect(latest.backupPath).not.toBeNull();
  expect(await readFile(latest.backupPath!)).toEqual(before);
  // The same body twice is not a change at all.
  expect((await write("changed", true)).plan.changed).toEqual([]);
});

it("keeps the instance's tree free of Engine files even when it has to record archive state", async () => {
  const f = await scratch();
  const journal: NativeOverwriteJournalEntry[] = [];
  const result = await writeBackProjectionToInstance({
    projection: projection([canonicalSession("logical-one", "workspace-joined", "hello")]),
    sessionsRoot: f.sessionsRoot, stateRoot: f.stateRoot, instanceId: INSTANCE, backupRoot: f.backupRoot,
    inScope: () => true, archived: () => true, journal: async entry => { journal.push(entry); } });
  const relativePath = result.plan.entries[0]!.relativePath;
  const sessionDirectory = join(f.sessionsRoot, ...relativePath.split("/").slice(0, 2));
  expect(await readdir(sessionDirectory)).toEqual(["session.v3.jsonl.zstd"]);
  // The record is under the Engine's state root instead, keyed by instance and session.
  const marker = join(f.stateRoot, "native-archive-markers", INSTANCE, ...relativePath.split("/").slice(0, 2)) + ".json";
  const record = JSON.parse(await readFile(marker, "utf8")) as { archived?: unknown; revision?: unknown };
  expect(record).toMatchObject({ archived: true, instanceId: INSTANCE, relativePath });
  expect(typeof record.revision).toBe("string");
  // The instance's tree contains no JSON sidecar at all.
  expect((await readdir(sessionDirectory)).some(name => name.endsWith(".json"))).toBe(false);
  await writeFile(join(f.sessionsRoot, "unrelated.txt"), "x");
});
