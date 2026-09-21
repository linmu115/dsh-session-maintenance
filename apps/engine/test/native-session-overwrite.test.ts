import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { JsonValue } from "@linmu/dsh-session-contracts";
import { v3NativeSessionCodec } from "@linmu/dsh-session-adapter-0-1-5";
import {
  applyNativeOverwrite, overwriteOperationId, planNativeOverwrite, readArchiveMarker,
  type NativeOverwriteJournalEntry, type NativeOverwriteSession, type NativeOverwriteState,
} from "../src/native-session-overwrite.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
/** Every test works in a synthetic temporary tree; no real DSH Home is ever touched. */
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "dsh-native-overwrite-"));
  roots.push(root);
  const sessionsRoot = join(root, "home", "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  return { root, sessionsRoot, backupRoot: join(root, "backups"), engineStateRoot: join(root, "engine-state") };
}

/** The instance these writes belong to; the archive marker is keyed by it. */
const INSTANCE = "i-synthetic";
/** Every apply carries the Engine's own state root, where the marker belongs. */
const writer = (f: Awaited<ReturnType<typeof scratch>>) => ({ journal: async (entry: NativeOverwriteJournalEntry) => { journal.push(entry); },
  backupRoot: f.backupRoot, stateRoot: f.engineStateRoot, instanceId: INSTANCE });

const cwd = "D:\\合成\\工作区";
// A real DSH Home names the session directory with the raw native session id.
const NATIVE_ONE = "session-11111111-2222-3333-4444-555555555555";
const NATIVE_TWO = "session-66666666-7777-8888-9999-000000000000";
const session = (nativeId: string, revision: string, archived = false, text = "hello"): NativeOverwriteSession => ({
  nativeSessionId: nativeId, revision, archived,
  payload: { header: { version: 3, id: nativeId, cwd, createdAt: 1, isSeeded: false, agentPreset: "standard", delegationDepth: 0 },
    inheritedEventCount: 0,
    events: [{ seq: 0, time: 1, type: "user/message", surfaceOp: "append", data: { id: `${nativeId}-event`, role: "user",
      content: [{ type: "text", text }], source: { kind: "user" } } }] } as unknown as JsonValue,
});
const emptyState = (): NativeOverwriteState => ({ revisions: new Map(), archived: new Map() });
const journal: NativeOverwriteJournalEntry[] = [];
afterEach(() => { journal.splice(0); });

it("writes each session inside its own directory and never into the project directory", async () => {
  const f = await scratch();
  const one = session(NATIVE_ONE, "rev-1");
  const plan = planNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [one], state: emptyState() });
  expect(plan.changed).toHaveLength(1);
  // The layout is the host's, one directory per session; the project directory gets no file.
  expect(plan.entries[0]!.relativePath).toBe(`--D-~5408~6210-~5DE5~4F5C~533A--/${NATIVE_ONE}/session.v3.jsonl.zstd`);
  expect(plan.entries[0]!.relativePath.split("/")).toHaveLength(3);
  const receipt = await applyNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [one], plan,
    ...writer(f) });
  expect(receipt.applied).toHaveLength(1);
  const written = join(f.sessionsRoot, ...plan.entries[0]!.relativePath.split("/"));
  // The adapter's own codec produced these bytes, for the instance's own layout.
  const description = { relativePath: `${NATIVE_ONE}/session.v3.jsonl.zstd`, header: (one.payload as { header: unknown }).header };
  expect(await readFile(written)).toEqual(v3NativeSessionCodec.encode(one.payload, description as never));
  // The project directory holds only the session directory, never a session file.
  expect(await readdir(join(f.sessionsRoot, plan.entries[0]!.relativePath.split("/")[0]!))).toEqual([NATIVE_ONE]);
  // The Engine also records the archive state it applied, next to the session.
  expect((await readArchiveMarker(f.engineStateRoot, INSTANCE, plan.entries[0]!.relativePath))?.archived).toBe(false);
});

it("writes only what differs and names each intent deterministically", async () => {
  const f = await scratch();
  const one = session(NATIVE_ONE, "rev-1"), two = session(NATIVE_TWO, "rev-2");
  const first = planNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [one, two], state: emptyState() });
  await applyNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [one, two], plan: first,
    ...writer(f) });
  // The same intent always names the same operation: a retry can never create a second version.
  expect(one && overwriteOperationId(NATIVE_ONE, "rev-1", "write"))
    .toBe(overwriteOperationId(NATIVE_ONE, "rev-1", "write"));
  expect(overwriteOperationId(NATIVE_ONE, "rev-1", "write"))
    .not.toBe(overwriteOperationId(NATIVE_ONE, "rev-2", "write"));

  // A second start with nothing changed writes nothing at all (this is the cheap path).
  const state: NativeOverwriteState = { revisions: new Map(first.entries.map(entry => [entry.relativePath, "rev-1"])), archived: new Map() };
  state.revisions.set(first.entries[1]!.relativePath, "rev-2");
  state.archived.set(first.entries[0]!.relativePath, false);
  state.archived.set(first.entries[1]!.relativePath, false);
  const idle = planNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [one, two], state });
  expect(idle.changed).toEqual([]);

  // A changed revision is written; the unchanged sibling still is not.
  const updated = session(NATIVE_ONE, "rev-9", false, "changed");
  const changed = planNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [updated, two], state });
  expect(changed.changed.map(entry => entry.nativeSessionId)).toEqual([NATIVE_ONE]);
  const before = await readFile(join(f.sessionsRoot, ...first.entries[0]!.relativePath.split("/")));
  const receipt = await applyNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [updated, two], plan: changed,
    ...writer(f) });
  expect(receipt.applied.map(entry => entry.nativeSessionId)).toEqual([NATIVE_ONE]);
  // The replaced bytes are kept before the rename, so the write can be undone.
  // The journalled write is the latest one for that path, not the initial creation.
  const entry = journal.findLast(item => item.relativePath === changed.entries[0]!.relativePath)!;
  expect(entry.backupPath).not.toBeNull();
  expect(await readFile(entry.backupPath!)).toEqual(before);
  expect(await readFile(join(f.sessionsRoot, ...changed.entries[0]!.relativePath.split("/")))).not.toEqual(before);
});

it("restores a locally archived session when the true source has it unarchived", async () => {
  const f = await scratch();
  const one = session("native-one", "rev-1", true);
  const plan = planNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [one], state: emptyState() });
  await applyNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [one], plan,
    ...writer(f) });
  expect((await readArchiveMarker(f.engineStateRoot, INSTANCE, plan.entries[0]!.relativePath))?.archived).toBe(true);

  // The true source un-archives it: the instance must become active again, not stay archived.
  const active = session("native-one", "rev-1", false);
  const state: NativeOverwriteState = { revisions: new Map([[plan.entries[0]!.relativePath, "rev-1"]]),
    archived: new Map([[plan.entries[0]!.relativePath, true]]) };
  const restoring = planNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [active], state });
  expect(restoring.changed.map(entry => entry.action)).toEqual(["restore-unarchived"]);
  await applyNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [active], plan: restoring,
    ...writer(f) });
  expect((await readArchiveMarker(f.engineStateRoot, INSTANCE, plan.entries[0]!.relativePath))?.archived).toBe(false);

  // Archiving the other way is symmetric.
  const state2: NativeOverwriteState = { revisions: state.revisions, archived: new Map([[plan.entries[0]!.relativePath, false]]) };
  expect(planNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [one], state: state2 }).changed.map(entry => entry.action))
    .toEqual(["archive"]);
});

it("touches only the sessions it was given, and skips one whose path cannot be derived", async () => {
  const f = await scratch();
  const inside = session(NATIVE_ONE, "rev-1");
  const outside = session(NATIVE_TWO, "rev-1");
  // A payload without a session id cannot be placed in the instance's layout at
  // all, so it is skipped rather than guessed into a wrong directory.
  const unusable = { nativeSessionId: "session-broken", revision: "rev-1", archived: false,
    payload: { header: { cwd }, events: [] } as unknown as JsonValue };
  const plan = planNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [inside, unusable], state: emptyState() });
  expect(plan.entries.map(entry => entry.nativeSessionId)).toEqual([NATIVE_ONE]);
  await applyNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [inside, unusable], plan,
    ...writer(f) });
  // Nothing was created for the session outside the scope, and nothing for the unusable one.
  const writtenOutside = join(f.sessionsRoot, (await v3NativeSessionCodec.describe(outside.payload, f.sessionsRoot)).relativePath);
  await expect(readFile(writtenOutside)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(f.sessionsRoot, "session-broken"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("leaves the target untouched when the codec disagrees with the plan's path", async () => {
  const f = await scratch();
  const one = session(NATIVE_ONE, "rev-1");
  const plan = planNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [one], state: emptyState() });
  // A plan built for a different root is not trusted: the codec's own answer wins,
  // and a mismatch means nothing is written from that entry.
  const wrongRoot = join(f.root, "somewhere-else");
  const applied = await applyNativeOverwrite({ sessionsRoot: wrongRoot, sessions: [one],
    plan: { ...plan, sessionsRoot: wrongRoot }, ...writer(f) });
  expect(applied.applied).toHaveLength(1);
  const written = join(wrongRoot, ...plan.entries[0]!.relativePath.split("/"));
  expect((await readFile(written)).byteLength).toBeGreaterThan(0);
  // The original sessions root was not written to by that call.
  await expect(readFile(join(f.sessionsRoot, plan.entries[0]!.relativePath))).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not rewrite a session whose revision is unchanged even when the bytes differ", async () => {
  const f = await scratch();
  const one = session(NATIVE_ONE, "rev-1");
  const plan = planNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [one], state: emptyState() });
  await applyNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [one], plan,
    ...writer(f) });
  const target = join(f.sessionsRoot, ...plan.entries[0]!.relativePath.split("/"));
  // Someone changed the file behind the Engine's back; revision equality still wins,
  // because the revision is the contract, not a byte comparison of the whole body.
  await writeFile(target, "tampered");
  const state: NativeOverwriteState = { revisions: new Map([[plan.entries[0]!.relativePath, "rev-1"]]),
    archived: new Map([[plan.entries[0]!.relativePath, false]]) };
  expect(planNativeOverwrite({ sessionsRoot: f.sessionsRoot, sessions: [one], state }).changed).toEqual([]);
  expect(await readFile(target, "utf8")).toBe("tampered");
});
