import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CanonicalSessionEngine } from "@linmu/dsh-canonical-session-engine";
import type { CanonicalEventV1, LogicalWorkspace, LogicalWorkspaceId, NativeSessionId } from "@linmu/dsh-session-contracts";
import { v3NativeSessionCodec } from "@linmu/dsh-session-adapter-0-1-5";
import { openMaintenanceDatabase, SqliteCanonicalRepository, SqliteCanonicalSessionEngineStore, ZstdContentObjectStore } from "@linmu/dsh-session-store";
import { createInstanceWorkspaceSource } from "../src/instance-workspace-source.js";
import { SessionMaintenanceQueries } from "../src/session-maintenance-queries.js";
import {
  joinWorkspaceOperationId, mapJoinedWorkspace, mappedLogicalSessionId,
  type JoinedWorkspaceSource, type MappedNativeSession,
} from "../src/workspace-session-mapping.js";

const at = "2026-09-21T10:00:00.000Z";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

/** A synthetic engine-side store; no instance Home is read or written here. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-workspace-mapping-"));
  await writeFile(join(root, ".synthetic-fixture"), "No real DSH or Codex homes");
  const db = openMaintenanceDatabase(join(root, "metadata.sqlite"));
  const repository = new SqliteCanonicalRepository(db);
  const engine = new CanonicalSessionEngine(new SqliteCanonicalSessionEngineStore(db, new ZstdContentObjectStore(root)));
  cleanups.push(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const folders = new Map<string, LogicalWorkspace>();
  const workspaces = {
    read: async (id: LogicalWorkspaceId) => folders.get(id),
    upsert: async (workspace: LogicalWorkspace) => { folders.set(workspace.id, workspace); await repository.upsertLogicalWorkspace(workspace); },
  };
  return { engine, workspaces, folders, db, root };
}

/** One readable native session, in the shape the mapping service consumes. */
function nativeSession(nativeSessionId: string, title: string, archivedAt: string | null = null): MappedNativeSession {
  return { nativeSessionId: nativeSessionId as NativeSessionId, title, tags: [], archivedAt,
    events: [{ schemaVersion: 1, id: `event-${nativeSessionId}` as never, logicalSessionId: mappedLogicalSessionId("i-one", nativeSessionId),
      sequence: 0, kind: "user-message", role: "user", content: { text: "hello" }, contentDigest: `sha256:${nativeSessionId}`,
      rawPayload: null, extensions: {},
      source: { platform: "dsh", instanceId: "i-one", sessionId: nativeSessionId, eventId: "0", cursor: "0" } } as unknown as CanonicalEventV1] };
}

function source(sessions: readonly MappedNativeSession[], unreadable: readonly string[] = []): JoinedWorkspaceSource {
  return {
    list: async () => sessions.map(session => session.nativeSessionId),
    read: async nativeSessionId => {
      if (unreadable.includes(String(nativeSessionId))) throw new Error(`synthetic unreadable ${nativeSessionId}`);
      const found = sessions.find(session => session.nativeSessionId === nativeSessionId);
      if (found === undefined) throw new Error(`no such session ${nativeSessionId}`);
      return found;
    },
  };
}

it("creates the workspace's folder in Maintenance's own store and maps every session it has", async () => {
  const f = await fixture();
  const receipt = await mapJoinedWorkspace({ engine: f.engine, workspaces: f.workspaces, instanceId: "i-one",
    workspaceKey: "project-joined", workspaceName: "DeepSeekDemoWorkplace",
    source: source([nativeSession("session-aaa", "会话 A"), nativeSession("session-bbb", "会话 B")]),
    clock: () => at });
  // The "folder" is a row in the maintenance store, not a physical directory.
  expect(receipt.created).toBe(true);
  const folder = f.folders.get(receipt.workspaceId)!;
  expect(folder).toMatchObject({ name: "DeepSeekDemoWorkplace", parentId: null, deletedAt: null });
  expect(receipt.mapped).toHaveLength(2);
  expect(receipt.failures).toEqual([]);
  // Both sessions are structured canonical rows belonging to that folder.
  for (const nativeSessionId of ["session-aaa", "session-bbb"]) {
    const detail = await f.engine.store.getSession(mappedLogicalSessionId("i-one", nativeSessionId));
    expect(detail?.session.originKind).toBe("maintenance-native");
    expect(detail?.workspaceId).toBe(receipt.workspaceId);
  }
});

it("reads a joined workspace's existing sessions out of the instance directory", async () => {
  const f = await fixture();
  // A synthetic instance tree, written with the adapter's own encoder so the
  // inspector sees exactly what a real DSH Home holds.
  const instanceRoot = join(f.root, "instance");
  const projectDirectory = "--D-~5402~5408~5DE5~4F5C~533A--";
  const sessionId = "session-77777777-8888-9999-aaaa-bbbbbbbbbbbb";
  const payload = { header: { version: 3, id: sessionId, cwd: "D:\\合成\\工作区", createdAt: Date.parse(at),
      delegationDepth: 0, isSeeded: false }, inheritedEventCount: 0,
    events: [{ seq: 0, time: Date.parse(at), type: "user/message", surfaceOp: "append",
      data: { id: "e0", role: "user", content: [{ type: "text", text: "hello" }], source: { kind: "user" } } }] };
  const projectRoot = join(instanceRoot, "sessions", projectDirectory);
  const description = await v3NativeSessionCodec.describe(payload as never, projectRoot);
  const file = join(projectRoot, description.relativePath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, v3NativeSessionCodec.encode(payload as never, description));

  const receipt = await mapJoinedWorkspace({ engine: f.engine, workspaces: f.workspaces, instanceId: "i-one",
    workspaceKey: "project-joined", workspaceName: "工作区",
    source: createInstanceWorkspaceSource({ sessionsRoot: projectRoot, instanceId: "i-one",
      logicalSessionId: nativeSessionId => mappedLogicalSessionId("i-one", nativeSessionId) }), clock: () => at });
  expect(receipt.failures).toEqual([]);
  expect(receipt.mapped).toHaveLength(1);
  // The mapped session is the one the instance's own directory held.
  const mapped = await f.engine.store.getSession(mappedLogicalSessionId("i-one", description.header.id as string));
  expect(mapped?.workspaceId).toBe(receipt.workspaceId);
});

it("maps only once: joining again reports the sessions it already knows", async () => {
  const f = await fixture();
  const input = { engine: f.engine, workspaces: f.workspaces, instanceId: "i-one", workspaceKey: "project-joined",
    workspaceName: "DeepSeekDemoWorkplace", source: source([nativeSession("session-aaa", "会话 A")]), clock: () => at };
  const first = await mapJoinedWorkspace(input);
  expect(first.mapped).toHaveLength(1);
  const second = await mapJoinedWorkspace(input);
  expect(second.created).toBe(false);
  expect(second.workspaceId).toBe(first.workspaceId);
  expect(second.mapped).toEqual([]);
  expect(second.alreadyPresent.map(String)).toEqual(["session-aaa"]);
  // The operation id is derived, so a retry of the same join can never produce a second version.
  expect(joinWorkspaceOperationId("i-one", first.workspaceId, "session-aaa"))
    .toBe(joinWorkspaceOperationId("i-one", first.workspaceId, "session-aaa"));
});

it("maps what it can and reports an unreadable session instead of denying the whole join", async () => {
  const f = await fixture();
  const receipt = await mapJoinedWorkspace({ engine: f.engine, workspaces: f.workspaces, instanceId: "i-one",
    workspaceKey: "project-joined", workspaceName: "DeepSeekDemoWorkplace",
    source: source([nativeSession("session-aaa", "会话 A"), nativeSession("session-bbb", "会话 B")], ["session-bbb"]),
    clock: () => at });
  // The operator still gets the folder and the sessions that could be read.
  expect(receipt.mapped).toHaveLength(1);
  expect(receipt.failures).toEqual([{ nativeSessionId: "session-bbb", reason: expect.stringContaining("synthetic unreadable") }]);
  expect(await f.engine.store.getSession(mappedLogicalSessionId("i-one", "session-aaa"))).toBeDefined();
  expect(await f.engine.store.getSession(mappedLogicalSessionId("i-one", "session-bbb"))).toBeUndefined();
});

it("keeps two instances' mappings apart and renames only the folder label on a later join", async () => {
  const f = await fixture();
  const one = await mapJoinedWorkspace({ engine: f.engine, workspaces: f.workspaces, instanceId: "i-one",
    workspaceKey: "project-joined", workspaceName: "DeepSeekDemoWorkplace",
    source: source([nativeSession("session-aaa", "会话 A")]), clock: () => at });
  const two = await mapJoinedWorkspace({ engine: f.engine, workspaces: f.workspaces, instanceId: "i-two",
    workspaceKey: "project-joined", workspaceName: "DeepSeekDemoWorkplace",
    source: source([nativeSession("session-aaa", "会话 A")]), clock: () => at });
  // The same native session of another instance is a different canonical session.
  expect(two.workspaceId).not.toBe(one.workspaceId);
  expect(mappedLogicalSessionId("i-two", "session-aaa")).not.toBe(mappedLogicalSessionId("i-one", "session-aaa"));

  // Joining the same workspace again with a new label only refreshes the folder.
  const renamed = await mapJoinedWorkspace({ engine: f.engine, workspaces: f.workspaces, instanceId: "i-one",
    workspaceKey: "project-joined", workspaceName: "重命名后的工作区",
    source: source([nativeSession("session-aaa", "会话 A")]), clock: () => at });
  expect(renamed.workspaceId).toBe(one.workspaceId);
  expect(f.folders.get(one.workspaceId)!.name).toBe("重命名后的工作区");
  expect(renamed.mapped).toEqual([]);
});

it("makes the mapped folder and its sessions visible on the board", async () => {
  const f = await fixture();
  const receipt = await mapJoinedWorkspace({ engine: f.engine, workspaces: f.workspaces, instanceId: "i-one",
    workspaceKey: "project-joined", workspaceName: "DeepSeekDemoWorkplace",
    source: source([nativeSession("session-aaa", "会话 A"), nativeSession("session-bbb", "会话 B", at)]), clock: () => at });
  // The board reads the same maintenance store: one folder, its active session, and
  // the archived one reported as archived rather than hidden.
  const directory = await new SessionMaintenanceQueries(f.db).readCanonicalWorkspaceDirectory();
  const folder = directory.workspaces.find(entry => entry.workspace.id === receipt.workspaceId)!;
  expect(folder.workspace.name).toBe("DeepSeekDemoWorkplace");
  expect(folder.sessions.map(item => item.session.title).sort()).toEqual(["会话 A", "会话 B"]);
  expect(folder.sessions.find(item => item.session.title === "会话 B")!.membership.archived).toBe(true);
});

it("records the session's archive state as the membership the board shows", async () => {
  const f = await fixture();
  const receipt = await mapJoinedWorkspace({ engine: f.engine, workspaces: f.workspaces, instanceId: "i-one",
    workspaceKey: "project-joined", workspaceName: "DeepSeekDemoWorkplace",
    source: source([nativeSession("session-aaa", "会话 A", at)]), clock: () => at });
  // Archived in the true source means archived in the maintenance folder: the
  // membership row the board reads carries the state, not the session bytes.
  expect(f.db.prepare("SELECT workspace_id, archived FROM workspace_memberships WHERE logical_session_id=?").get(receipt.mapped[0]!))
    .toEqual({ workspace_id: receipt.workspaceId, archived: 1 });
  // An unarchived session of the same workspace maps as active.
  const active = await mapJoinedWorkspace({ engine: f.engine, workspaces: f.workspaces, instanceId: "i-one",
    workspaceKey: "project-active", workspaceName: "另一个工作区",
    source: source([nativeSession("session-ccc", "会话 C")]), clock: () => at });
  expect(f.db.prepare("SELECT archived FROM workspace_memberships WHERE logical_session_id=?").get(active.mapped[0]!))
    .toEqual({ archived: 0 });
});
