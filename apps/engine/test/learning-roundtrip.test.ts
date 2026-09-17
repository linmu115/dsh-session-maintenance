import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalEventV1, LearningCodexPort, LearningCursor, LearningMessage, LearningSnapshot } from "@linmu/dsh-session-contracts";
import { sha256Canonical, withPlannedConversationTopology } from "@linmu/dsh-session-domain";
import { appendLearningV3, prepareLearningV3 } from "@linmu/dsh-session-extension-gpt-compat";
import { MaintenanceClient } from "../../../packages/local-api-client/src/index.js";
import { SqliteProjectionRunRepository } from "@linmu/dsh-session-store";
import { createEngineFixture } from "./helpers.js";
import { LearningService } from "../src/learning-service.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanups.splice(0)) await stop(); });
const at = "2026-09-17T00:00:00.000Z";
const message = (id: string, role: "user" | "assistant", text: string): LearningMessage => ({ id, role, text, startedAt: "2026-09-17T00:02:00.000Z", completedAt: "2026-09-17T00:03:00.000Z" });
class FakeCodex implements LearningCodexPort {
  all = [message("u", "user", "A?"), message("a", "assistant", "A!")]; busy = false; injections = 0;
  mutateRead?: () => void;
  cursor(): LearningCursor { return { count: this.all.length, digest: sha256Canonical(this.all) }; }
  async read(_target: unknown, _thread: string, after?: LearningCursor): Promise<LearningSnapshot> {
    this.mutateRead?.();
    if (after && sha256Canonical(this.all.slice(0, after.count)) !== after.digest) throw new Error("Codex history changed");
    return { cursor: this.cursor(), messages: this.all.slice(after?.count ?? 0), busy: this.busy, name: "Learning" };
  }
  async inject(_target: unknown, _thread: string, before: LearningCursor, _operation: string, messages: readonly LearningMessage[]) {
    if (before.digest !== this.cursor().digest) throw new Error("changed");
    this.injections++; this.all.push(...messages); return this.read(null, "thread");
  }
}
async function setup() {
  const f = await createEngineFixture("learning-roundtrip"); cleanups.push(f.stop);
  const db = f.engine.repository.database;
  const input = [message("u", "user", "A?"), message("a", "assistant", "A!"), message("b-u", "user", "B?"), message("b-a", "assistant", "B!")];
  const events = withPlannedConversationTopology(input.map((m, i): CanonicalEventV1 => ({ schemaVersion: 1, id: m.id, logicalSessionId: "learning" as never, sequence: i,
    kind: m.role === "user" ? "user-message" : "assistant-message", role: m.role, content: { text: m.text, attachments: [] }, contentDigest: sha256Canonical({ text: m.text, attachments: [] }),
    source: { platform: "codex", instanceId: "codex-fixture", sessionId: "thread", eventId: m.id, cursor: String(i) }, rawPayload: null, extensions: {} }))).events;
  await f.engine.canonicalEngine.observeCodex({ logicalSessionId: "learning" as never, title: "Synthetic learning", tags: [], archivedAt: null, workspaceId: null, events, observedAt: at, sourceCursor: null });
  db.prepare("INSERT INTO platform_bindings VALUES('learning-codex','learning','codex','codex-fixture','thread','{}',NULL,'read-only')").run();
  const runs = new SqliteProjectionRunRepository(db);
  const adapter = db.prepare("SELECT adapter_id FROM adapter_registrations LIMIT 1").get()!.adapter_id as string;
  await runs.createProjectionRun({ schemaVersion: 1, id: "learning-run" as never, leaseId: "learning-lease" as never, branchId: "learning-branch" as never,
    instanceId: "dsh-fixture", profileId: "web", dshVersion: "0.1.5-rc.2", adapterId: adapter as never, state: "closed", startedAt: at, heartbeatAt: at, checkpointId: null });
  const native = `dsh-maintenance_${Buffer.from("learning").toString("base64url")}`;
  await runs.upsertProjectionSession({ schemaVersion: 1, runId: "learning-run" as never, nativeSessionId: native as never, logicalSessionId: "learning" as never,
    baseVersionId: null, mode: "codex-read-until-write", nativeRevision: 0, lastCommittedOperationId: null, derivedChildSessionId: null });
  const port = new FakeCodex();
  const target = { id: "learning-target", codexInstanceId: "codex-fixture", platformVersion: "0.153.4", cwd: f.root, runtimeWorkspaceRoots: [f.root], contextWindowTokens: 100000, inputBudgetRatio: .8, codexHome: f.codexHome };
  const service = new LearningService(f.engine, [target], port, () => "2026-09-17T00:01:00.000Z");
  const bind = () => service.bind({ logicalSessionId: "learning", codexThreadId: "thread", dshRunId: "learning-run", targetPresetId: target.id, confirmed: true });
  return { ...f, db, runs, port, service, bind, target };
}
describe("learning roundtrip", () => {
  it("keeps ordinary DSH continuation on the owned identity and skips scanner reassignment", async () => {
    const f = await setup(), b = await f.bind();
    const snapshot = (await f.engine.canonicalEngine.store.getSession("learning" as never))!;
    const version = (await f.engine.canonicalEngine.store.getVersion(snapshot.headVersionId!))!;
    const run = (await f.runs.getProjectionRun("learning-run" as never))!;
    const appendedEvents = await appendLearningV3({ session: snapshot.session, events: version.events, workspaceId: null }, run,
      [message("du", "user", "DSH next?"), message("da", "assistant", "DSH next!")], "dsh-operation", at);
    const result = await f.engine.canonicalEngine.appendDsh({ logicalSessionId: snapshot.session.id, baseVersionId: version.id,
      title: snapshot.session.title, tags: [], archivedAt: null, workspaceId: null, appendedEvents, canonicalHistoryMode: "native", observedAt: at,
      projection: { runId: run.id, leaseId: run.leaseId, branchId: run.branchId, adapterId: run.adapterId, nativeSessionId: b.dshNativeSessionId as never,
        operationId: "dsh-operation" as never, nativeRevision: 999 } });
    expect(result.logicalSessionId).toBe("learning");
    expect(f.db.prepare("SELECT COUNT(*) n FROM session_derivations").get()!.n).toBe(0);
    const { applyCodexCanonicalImportPlan } = await import("../src/codex-canonical-import.js");
    const projectPort = { ensureWorkspace: vi.fn(), recordAssignment: vi.fn() };
    const scanned = await applyCodexCanonicalImportPlan({ canonicalEngine: f.engine.canonicalEngine, projectPort,
      plan: { scanned: 1, retried: 0, projectAssignments: [], sessions: [{ logicalSessionId: "learning", sourceSessionId: "thread",
        authorityBinding: { key: { instanceId: "codex-fixture" } } }] } } as never);
    expect(scanned.noop).toBe(1); expect(projectPort.ensureWorkspace).not.toHaveBeenCalled(); expect(projectPort.recordAssignment).not.toHaveBeenCalled();
  });
  it("exposes authenticated API only and keeps title-only changes outside the body lock", async () => {
    const f = await setup(), b = await f.bind(); await f.service.send(b.id);
    const beforeRevision = f.service.directory().bindings[0]!.revision;
    const current = await f.engine.canonicalEngine.store.getSession("learning" as never);
    const version = await f.engine.canonicalEngine.store.getVersion(current!.headVersionId!);
    const { buildCanonicalVersion } = await import("@linmu/dsh-canonical-session-engine");
    const renamed = buildCanonicalVersion({ logicalSessionId: current!.session.id, parentVersionIds: [version!.id], events: version!.events,
      workspaceId: null, title: "Renamed lesson", tags: [], archivedAt: null, createdAt: at });
    await f.engine.canonicalEngine.store.commit({ kind: "dsh-append", operationId: null,
      session: { ...current!.session, title: "Renamed lesson", headVersionId: renamed.id }, version: renamed,
      membership: null, derivation: null, projectionReceipt: null, tombstone: null, observation: null,
      receipt: { outcome: "advanced", operationId: null, logicalSessionId: current!.session.id, versionId: renamed.id, tombstoneState: null, committedAt: at } });
    expect(f.service.directory().bindings[0]!.revision).toBe(beforeRevision);
    expect(f.service.directory().bindings[0]!.title).toBe("Renamed lesson");
    const server = await f.startServer();
    expect((await fetch(`${server.origin}/v1/learning`)).status).toBe(401);
    expect((await fetch(`${server.origin}/v1/learning/${b.id}/collect`, { method: "POST" })).status).toBe(401);
    const client = new MaintenanceClient({ origin: server.origin, token: server.token });
    expect((await client.learningDirectory()).bindings[0]!.id).toBe(b.id);
    await expect(client.bindLearning({ logicalSessionId: "missing", codexThreadId: "missing", dshRunId: "missing", targetPresetId: "missing", confirmed: true })).rejects.toThrow();
    expect((await client.learningAction(b.id, "disable")).state).toBe("disabled");
  });
  it("keeps A+B+C in the same identity, preserves prefix, consumes a receipt once and resumes native DSH", async () => {
    const f = await setup(); const b = await f.bind();
    const original = await f.engine.canonicalEngine.store.getSession("learning" as never);
    const before = await f.engine.canonicalEngine.store.getVersion(original!.headVersionId!);
    expect(original!.session.authorityScope).toBe("maintenance");
    await f.service.send(b.id); await f.service.send(b.id); expect(f.port.injections).toBe(1);
    f.port.all.push(message("c-u", "user", "C?"), message("c-a", "assistant", "C!"));
    expect((await f.service.collect(b.id)).state).toBe("collected");
    const session = await f.engine.canonicalEngine.store.getSession("learning" as never);
    const head = await f.engine.canonicalEngine.store.getVersion(session!.headVersionId!);
    expect(head!.events.slice(0, before!.events.length)).toEqual(before!.events);
    const native = await prepareLearningV3({ session: session!.session, events: head!.events, workspaceId: null }, (await f.runs.getProjectionRun("learning-run" as never))!);
    expect(native.messages.map(m => m.text)).toEqual(["A?", "A!", "B?", "B!", "C?", "C!"]);
    await f.service.collect(b.id); expect((await f.engine.canonicalEngine.store.getSession("learning" as never))!.headVersionId).toBe(head!.id);
    expect(f.db.prepare("SELECT COUNT(*) n FROM session_derivations").get()!.n).toBe(0);
    const restarted = new LearningService(f.engine, [f.target], f.port);
    expect(restarted.directory().bindings[0]!.state).toBe("collected");
  });
  it("rejects active DSH, mismatched histories and generation that began before sync", async () => {
    const f = await setup();
    f.db.prepare("UPDATE projection_runs SET state='running'").run(); await expect(f.bind()).rejects.toThrow("正常停止");
    f.db.prepare("UPDATE projection_runs SET state='closed'").run();
    f.port.all[0] = message("x", "user", "different"); await expect(f.bind()).rejects.toThrow("共同前缀");
    f.port.all[0] = message("u", "user", "A?"); const b = await f.bind(); await f.service.send(b.id);
    f.port.all.push({ ...message("c", "user", "C?"), startedAt: at }, message("d", "assistant", "C!"));
    await expect(f.service.collect(b.id)).rejects.toThrow("同步成功后");
  });
  it("blocks DSH changes, including edits reverted back to the same head", async () => {
    const f = await setup(), b = await f.bind(); await f.service.send(b.id);
    const head = f.db.prepare("SELECT head_version_id FROM logical_sessions WHERE id='learning'").get()!.head_version_id;
    f.db.prepare("UPDATE logical_sessions SET head_version_id=NULL WHERE id='learning'").run();
    f.db.prepare("UPDATE logical_sessions SET head_version_id=? WHERE id='learning'").run(head!);
    await expect(f.service.collect(b.id)).rejects.toThrow("DSH 已变化");
  });
  it("rejects a second-end change during final validation without committing", async () => {
    const f = await setup(), b = await f.bind(); await f.service.send(b.id);
    f.port.all.push(message("c", "user", "C?"), message("d", "assistant", "C!"));
    const before = f.db.prepare("SELECT head_version_id FROM logical_sessions WHERE id='learning'").get()!.head_version_id;
    let reads = 0; f.port.mutateRead = () => { if (++reads === 2) f.port.all.push(message("e", "user", "D?")); };
    await expect(f.service.collect(b.id)).rejects.toThrow("提交前");
    expect(f.db.prepare("SELECT head_version_id FROM logical_sessions WHERE id='learning'").get()!.head_version_id).toBe(before);
  });
  it("does not import bound Codex observations as mirrors or advance its source-owned history", async () => {
    const f = await setup(); await f.bind();
    const owner = await f.engine.canonicalEngine.store.learningSourceOwner!("codex-fixture", "thread"); expect(owner!.session.id).toBe("learning");
    const result = await f.engine.canonicalEngine.observeCodex({ logicalSessionId: "another-auto-id" as never, title: "x", tags: [], archivedAt: null, workspaceId: null, events: [], observedAt: at, sourceCursor: null,
      authorityBinding: { bindingId: "x", key: { platform: "codex", instanceId: "codex-fixture", sessionId: "thread" }, adapterContract: {} as never, fingerprint: {} as never } });
    expect(result).toMatchObject({ outcome: "noop", logicalSessionId: "learning" });
    expect(await f.engine.canonicalEngine.store.getSession("another-auto-id" as never)).toBeUndefined();
  });
  it("verifies an interrupted send without injecting it again", async () => {
    const f = await setup(), b = await f.bind(), inject = f.port.inject.bind(f.port);
    f.port.inject = async (...args) => { await inject(...args); throw new Error("connection lost after persist"); };
    await expect(f.service.send(b.id)).rejects.toThrow("connection lost");
    expect(f.service.directory().bindings[0]!.state).toBe("uncertain");
    const restarted = new LearningService(f.engine, [f.target], f.port, () => "2026-09-17T00:01:30.000Z");
    expect((await restarted.verifySend(b.id)).state).toBe("sent");
    expect(f.port.injections).toBe(1);
  });
  it("rolls back the canonical head if consuming the receipt fails", async () => {
    const f = await setup(), b = await f.bind(); await f.service.send(b.id);
    const before = f.db.prepare("SELECT head_version_id FROM logical_sessions WHERE id='learning'").get()!.head_version_id;
    f.port.all.push(message("c", "user", "C?"), message("d", "assistant", "C!"));
    f.db.exec("CREATE TRIGGER reject_learning_receipt BEFORE UPDATE ON learning_handoffs BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END");
    await expect(f.service.collect(b.id)).rejects.toThrow("fixture receipt failure");
    expect(f.db.prepare("SELECT head_version_id FROM logical_sessions WHERE id='learning'").get()!.head_version_id).toBe(before);
    expect(f.service.directory().bindings[0]!.state).toBe("sent");
    f.db.exec("DROP TRIGGER reject_learning_receipt"); expect((await f.service.collect(b.id)).state).toBe("collected");
  });
  it("blocks endpoint migration until explicit revalidation and invalidates an old receipt", async () => {
    const f = await setup(), b = await f.bind(); await f.service.send(b.id);
    const moved = new LearningService(f.engine, [{ ...f.target, codexHome: f.target.codexHome + '-moved-fixture' }], f.port);
    await expect(moved.collect(b.id)).rejects.toThrow("迁移");
    expect((await moved.revalidate(b.id)).state).toBe("ready");
    await expect(moved.collect(b.id)).rejects.toThrow("没有可回收");
  });
  it("preserves empty collection state and refuses archived sessions", async () => {
    const f = await setup(), b = await f.bind(); await f.service.send(b.id);
    expect((await f.service.collect(b.id)).message).toBe("暂无新增问答");
    f.db.prepare("UPDATE logical_sessions SET archived_at=? WHERE id='learning'").run(at);
    await expect(f.service.collect(b.id)).rejects.toThrow("归档");
  });
});
