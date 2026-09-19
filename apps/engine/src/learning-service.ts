import { randomUUID, createHash } from "node:crypto";
import { buildCanonicalVersion } from "@linmu/dsh-canonical-session-engine";
import { CodexLearningAdapter } from "@linmu/dsh-adapter-codex-continuation";
import { appendLearningV3, prepareLearningV3 } from "@linmu/dsh-session-extension-gpt-compat";
import { learningBindSchema, ExtensionDataError, type LearningBinding, type LearningBind, type LearningCodexPort,
  type LearningCursor, type LearningDirectory, type LearningMessage, type CodexContinuationTarget, type CanonicalProjectionSessionInput } from "@linmu/dsh-session-contracts";
import type { SessionMaintenanceEngine } from "./engine.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (message: string): never => { throw new ExtensionDataError("LEARNING_CONFLICT", message, 409); };
interface Stored extends Omit<LearningBinding, "revision" | "blockedReason"> {
  dshRunId: string; codexInstanceId: string; endpointDigest: string; cursor: LearningCursor;
  syncedMessages: { role: string; textHash: string }[]; handoffId: string | null;
}
interface Handoff { revision: number; cursor: LearningCursor; sentAt: string; endpointDigest: string; consumed: boolean }
const contents = (messages: readonly LearningMessage[]) => messages.map(({ role, text }) => ({ role, textHash: hash(text) }));
const prefix = (a: readonly unknown[], b: readonly unknown[]) => a.length <= b.length && hash(a) === hash(b.slice(0, a.length));

/** One controlled owner for the experimental binding. Mutations share the Engine writer queue. */
export class LearningService {
  constructor(private readonly engine: SessionMaintenanceEngine, private readonly targets: readonly CodexContinuationTarget[],
    private readonly codex: LearningCodexPort = new CodexLearningAdapter(), private readonly now = () => new Date().toISOString()) {}
  private get db() { return this.engine.repository.database; }
  private target(id: string) { return this.targets.find(t => t.id === id) ?? fail("Codex 目标已失效，请重新配置关联"); }
  private endpoint(target: CodexContinuationTarget) { return hash([target.codexInstanceId, target.codexHome, target.command ?? null]); }
  private row(id: string) {
    const row = this.db.prepare("SELECT data_json,body_revision FROM learning_bindings WHERE id=?").get(id) as { data_json: string; body_revision: number } | undefined;
    if (!row) return fail("学习关联不存在");
    return { data: JSON.parse(row.data_json) as Stored, revision: row.body_revision };
  }
  private save(data: Stored) { this.db.prepare("UPDATE learning_bindings SET data_json=? WHERE id=?").run(JSON.stringify(data), data.id); }
  private sessionBlocked(data: Pick<Stored, "logicalSessionId" | "dshInstanceId" | "dshProfileId">) {
    const s = this.db.prepare("SELECT archived_at,tombstoned_at FROM logical_sessions WHERE id=?").get(data.logicalSessionId) as { archived_at: string | null; tombstoned_at: string | null } | undefined;
    if (!s || s.archived_at || s.tombstoned_at) return "会话已归档或删除，请先恢复并重新核对关联";
    if (this.db.prepare(`SELECT 1 FROM projection_runs r WHERE r.instance_id=? AND r.profile_id=? AND r.state NOT IN ('closed','recovered','quarantined')`).get(data.dshInstanceId, data.dshProfileId))
      return "对应 DSH 实例仍在运行或尚未完成收尾，请先通过 Launcher 正常停止，再刷新状态进行关联、同步或回收";
    if (this.db.prepare(`SELECT 1 FROM projection_runs r JOIN projection_sessions p ON p.run_id=r.id WHERE p.logical_session_id=? AND r.state NOT IN ('closed','recovered','quarantined')`).get(data.logicalSessionId)) return "同一会话仍在其它 DSH 实例运行，请先正常停止";
    // Quarantine is isolated, not an active lease. Only a later completed run of
    // this exact session on the same endpoint supersedes its association blocker.
    if (this.db.prepare(`SELECT 1 FROM projection_runs r
      LEFT JOIN projection_sessions p ON p.run_id=r.id AND p.logical_session_id=?
      WHERE r.state='quarantined' AND ((r.instance_id=? AND r.profile_id=?) OR p.logical_session_id IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM projection_runs newer JOIN projection_sessions np ON np.run_id=newer.id
        WHERE newer.instance_id=r.instance_id AND newer.profile_id=r.profile_id AND newer.started_at>r.started_at
        AND newer.state IN ('closed','recovered') AND np.logical_session_id=?)`)
      .get(data.logicalSessionId, data.dshInstanceId, data.dshProfileId, data.logicalSessionId))
      return "对应会话仍有尚未恢复的隔离运行，请先完成运行恢复，再刷新状态进行关联、同步或回收";
    if (this.db.prepare("SELECT 1 FROM run_operations WHERE logical_session_id=? AND status<>'committed'").get(data.logicalSessionId)) return "仍有未完成写入，请先完成运行恢复";
    return null;
  }
  private blocked(data: Stored) {
    const reason = this.sessionBlocked(data);
    if (reason) return reason;
    const target = this.targets.find(t => t.id === data.targetPresetId);
    if (!target || this.endpoint(target) !== data.endpointDigest) return "迁移后 Codex 端点已变化，旧交接失效，请重新核对关联";
    return null;
  }
  private check(data: Stored) { const reason = this.blocked(data); if (reason) fail(reason); }
  private public(id: string): LearningBinding {
    const { data, revision } = this.row(id);
    const { dshRunId: _run, codexInstanceId: _instance, endpointDigest: _endpoint, cursor: _cursor, syncedMessages: _messages, handoffId: _handoff, ...view } = data;
    const session = this.db.prepare("SELECT display_title FROM logical_sessions WHERE id=?").get(data.logicalSessionId) as { display_title: string } | undefined;
    return { ...view, title: session?.display_title ?? view.title, revision, blockedReason: this.blocked(data) };
  }
  directory(): LearningDirectory {
    const ids = this.db.prepare("SELECT id FROM learning_bindings ORDER BY id").all() as { id: string }[];
    const candidates = this.db.prepare(`SELECT s.id AS logicalSessionId,s.display_title AS title,b.session_id AS codexThreadId,b.instance_id AS codexInstanceId,
      r.id AS dshRunId,r.instance_id || ' / ' || r.profile_id AS dshLabel,r.instance_id AS dshInstanceId,r.profile_id AS dshProfileId
      FROM logical_sessions s JOIN platform_bindings b ON b.logical_session_id=s.id AND b.platform='codex'
      JOIN projection_sessions p ON p.logical_session_id=s.id JOIN projection_runs r ON r.id=p.run_id
      WHERE s.tombstoned_at IS NULL AND s.archived_at IS NULL AND r.dsh_version='0.1.5-rc.2'
      AND NOT EXISTS(SELECT 1 FROM learning_bindings l WHERE l.logical_session_id=s.id)
      AND r.started_at=(SELECT MAX(r2.started_at) FROM projection_runs r2 JOIN projection_sessions p2 ON p2.run_id=r2.id WHERE p2.logical_session_id=s.id)
      ORDER BY s.updated_at DESC LIMIT 200`).all() as unknown as (LearningDirectory["candidates"][number] & { dshInstanceId: string; dshProfileId: string })[];
    return { bindings: ids.map(({ id }) => this.public(id)), targets: this.targets.map(t => ({ id: t.id, label: t.id, codexInstanceId: t.codexInstanceId })),
      candidates: candidates.map(({ dshInstanceId, dshProfileId, ...candidate }) => ({ ...candidate,
        blockedReason: this.sessionBlocked({ logicalSessionId: candidate.logicalSessionId, dshInstanceId, dshProfileId }) })) };
  }
  private async projection(data: Stored) {
    const latest = this.db.prepare(`SELECT r.id,p.native_session_id FROM projection_runs r JOIN projection_sessions p ON p.run_id=r.id
      WHERE p.logical_session_id=? AND r.instance_id=? AND r.profile_id=? ORDER BY r.started_at DESC LIMIT 1`)
      .get(data.logicalSessionId, data.dshInstanceId, data.dshProfileId) as { id: string; native_session_id: string } | undefined;
    if (!latest || latest.native_session_id !== data.dshNativeSessionId) return fail("DSH 端点已变化，需重新核对关联");
    const run = await this.engine.projectionRunRepository.getProjectionRun(latest.id as never);
    if (!run || run.dshVersion !== "0.1.5-rc.2") return fail("目前仅验证 RC2 学习投影");
    const snapshot = await this.engine.canonicalEngine.store.getSession(data.logicalSessionId as never);
    const version = snapshot?.headVersionId ? await this.engine.canonicalEngine.store.getVersion(snapshot.headVersionId) : undefined;
    if (!snapshot || !version) return fail("学习会话缺少可验证版本");
    const item: CanonicalProjectionSessionInput = { session: snapshot.session, events: version.events, workspaceId: snapshot.workspaceId };
    return { item, run, snapshot, version, prepared: await prepareLearningV3(item, run) };
  }
  private async write<T>(operation: () => Promise<T>, signal?: AbortSignal) {
    if (!this.engine.writes) return fail("学习交接需要 Maintenance 独占写入协调器");
    const queued = new AbortController();
    const timeout = setTimeout(() => queued.abort(new ExtensionDataError("LEARNING_QUEUE_TIMEOUT",
      "维护写入队列繁忙，本次操作尚未开始并已取消。请稍后刷新状态重试；持续出现时需检查维护引擎。", 503)), 5_000);
    const pendingSignal = signal ? AbortSignal.any([queued.signal, signal]) : queued.signal;
    try {
      // Only queued work is cancellable. Never release the writer while an
      // already-started operation may still be committing or injecting history.
      return await this.engine.writes.run("learning-roundtrip", () => { clearTimeout(timeout); return operation(); }, pendingSignal);
    } finally { clearTimeout(timeout); }
  }
  async bind(input: LearningBind, signal?: AbortSignal): Promise<LearningBinding> {
    const q = learningBindSchema.parse(input);
    // Read-only rejection does not need to wait behind a busy writer. Repeat
    // identity and lifecycle validation inside the queue before any mutation.
    const preview = this.directory().candidates.find(c => c.logicalSessionId === q.logicalSessionId && c.codexThreadId === q.codexThreadId && c.dshRunId === q.dshRunId);
    if (!preview) return fail("请选择已核对的现有双端会话");
    if (preview.blockedReason) return fail(preview.blockedReason);
    return this.write(async () => {
      const candidate = this.directory().candidates.find(c => c.logicalSessionId === q.logicalSessionId && c.codexThreadId === q.codexThreadId && c.dshRunId === q.dshRunId);
      if (!candidate) return fail("请选择已核对的现有双端会话");
      const target = this.target(q.targetPresetId);
      if (candidate.codexInstanceId !== target.codexInstanceId) return fail("Codex 来源与目标不一致");
      const run = await this.engine.projectionRunRepository.getProjectionRun(q.dshRunId as never);
      const p = this.db.prepare("SELECT native_session_id FROM projection_sessions WHERE run_id=? AND logical_session_id=?").get(q.dshRunId, q.logicalSessionId) as { native_session_id: string };
      if (!run || !p) return fail("DSH 投影已失效");
      const data: Stored = { id: randomUUID(), logicalSessionId: q.logicalSessionId, title: candidate.title, targetPresetId: q.targetPresetId,
        codexThreadId: q.codexThreadId, codexInstanceId: target.codexInstanceId, dshInstanceId: run.instanceId, dshProfileId: run.profileId,
        dshNativeSessionId: p.native_session_id, dshRunId: q.dshRunId, state: "ready", message: "已确认关联，等待同步", sentAt: null,
        collectedAt: null, endpointDigest: this.endpoint(target), cursor: { count: 0, digest: "" }, syncedMessages: [], handoffId: null };
      this.check(data);
      const dsh = await this.projection(data), codex = await this.codex.read(target, q.codexThreadId);
      if (codex.busy) return fail("Codex 仍在回答，请完成后再关联");
      if (!prefix(contents(codex.messages), contents(dsh.prepared.messages))) return fail("双端已有问答不构成共同前缀，禁止按同名关联或合并");
      data.cursor = codex.cursor; data.syncedMessages = contents(codex.messages); this.check(data);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("INSERT INTO learning_bindings(id,logical_session_id,codex_instance_id,codex_thread_id,data_json) VALUES(?,?,?,?,?)")
          .run(data.id, data.logicalSessionId, data.codexInstanceId, data.codexThreadId, JSON.stringify(data));
        // Preserve identity, body, title, aliases and version ancestry; only the explicitly confirmed authority changes.
        this.db.prepare("UPDATE logical_sessions SET authority_scope='maintenance',origin_kind=CASE WHEN origin_kind='codex-mirror' THEN 'maintenance-native' ELSE origin_kind END WHERE id=?").run(data.logicalSessionId);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      return this.public(data.id);
    }, signal);
  }
  async send(id: string, signal?: AbortSignal): Promise<LearningBinding> {
    return this.write(async () => {
      const { data, revision } = this.row(id); this.check(data);
      if (data.state === "sent") return this.public(id);
      if (!["ready", "collected"].includes(data.state)) return fail("当前交接需先核验，不能重复注入历史");
      const target = this.target(data.targetPresetId), p = await this.projection(data);
      const full = contents(p.prepared.messages);
      if (!prefix(data.syncedMessages, full)) return fail("DSH 历史已修改，禁止把分叉内容投影到 Codex");
      const before = await this.codex.read(target, data.codexThreadId, data.cursor);
      if (before.busy || before.messages.length) return fail("Codex 有未回收内容或正在生成，禁止覆盖其进度");
      const delta = p.prepared.messages.slice(data.syncedMessages.length);
      if (JSON.stringify(p.prepared.messages).length > target.contextWindowTokens * target.inputBudgetRatio) return fail("交接内容超过保守预算，请先核对学习范围；不会静默截断");
      const handoffId = randomUUID(), started = this.now();
      data.state = "sending"; data.message = "正在确认 Codex 接收"; data.handoffId = handoffId;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.save(data);
        this.db.prepare("INSERT INTO learning_handoffs VALUES(?,?,?,?)").run(handoffId, id, JSON.stringify({ revision, before: before.cursor, started, consumed: false, pendingMessages: contents(delta), syncedMessages: full }), started);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      try {
        const received = delta.length ? await this.codex.inject(target, data.codexThreadId, before.cursor, handoffId, delta) : before;
        this.check(data);
        if (this.row(id).revision !== revision) return fail("同步期间 DSH 已变化");
        const sentAt = this.now();
        const handoff: Handoff = { revision, cursor: received.cursor, sentAt, endpointDigest: data.endpointDigest, consumed: false };
        data.cursor = received.cursor; data.syncedMessages = full; data.state = "sent"; data.sentAt = sentAt; data.message = "已送达；请重新启动 Codex 后继续原任务，确保桌面加载最新上下文";
        this.db.exec("BEGIN IMMEDIATE");
        try { this.db.prepare("UPDATE learning_handoffs SET data_json=? WHERE id=?").run(JSON.stringify(handoff), handoffId); this.save(data); this.db.exec("COMMIT"); }
        catch (error) { this.db.exec("ROLLBACK"); throw error; }
      } catch (error) { data.state = "uncertain"; data.message = error instanceof Error ? error.message : "同步结果待核验"; this.save(data); throw error; }
      return this.public(id);
    }, signal);
  }
  async collect(id: string, signal?: AbortSignal): Promise<LearningBinding> {
    return this.write(async () => {
      const { data, revision } = this.row(id); this.check(data);
      if (data.state === "collected") return this.public(id);
      if (data.state !== "sent" || !data.handoffId) return fail("没有可回收的成功交接");
      const receiptRow = this.db.prepare("SELECT data_json FROM learning_handoffs WHERE id=? AND binding_id=?").get(data.handoffId, id) as { data_json: string } | undefined;
      if (!receiptRow) return fail("交接回执缺失");
      const h = JSON.parse(receiptRow.data_json) as Handoff;
      if (h.consumed || h.revision !== revision || h.endpointDigest !== data.endpointDigest) return fail("同步后 DSH 已变化或交接失效，禁止追加");
      const target = this.target(data.targetPresetId), delta = await this.codex.read(target, data.codexThreadId, h.cursor);
      if (delta.busy) return fail("Codex 正在回答，请完成后再回收");
      if (!delta.messages.length) { data.message = "暂无新增问答"; this.save(data); return this.public(id); }
      if (delta.messages.some(m => !m.startedAt || !m.completedAt || !Number.isFinite(Date.parse(m.startedAt)) || !Number.isFinite(Date.parse(m.completedAt)) || Date.parse(m.startedAt) <= Date.parse(h.sentAt) || Date.parse(m.completedAt) < Date.parse(m.startedAt))) return fail("新增问答不是同步成功后开始并完成的学习轮次");
      const p = await this.projection(data), at = this.now();
      const appended = (await appendLearningV3(p.item, p.run, delta.messages, data.handoffId, at)).map(event => ({ ...event,
        extensions: { ...event.extensions, learningCodexThreadId: data.codexThreadId, learningCodexInstanceId: data.codexInstanceId } }));
      const offset = Math.max(0, (p.version.events.at(-1)?.sequence ?? -1) + 1 - (appended[0]?.sequence ?? 0));
      const version = buildCanonicalVersion({ logicalSessionId: p.snapshot.session.id, parentVersionIds: [p.version.id],
        events: [...p.version.events, ...appended.map(e => ({ ...e, sequence: e.sequence + offset }))], workspaceId: p.snapshot.workspaceId,
        title: p.snapshot.session.title, tags: p.snapshot.session.tags, archivedAt: p.snapshot.session.archivedAt, createdAt: at,
        allowForeignEventSessionIds: p.snapshot.session.originKind === "codex-derived" });
      // Recheck both owners after conversion and immediately before the atomic commit.
      const verify = await this.codex.read(target, data.codexThreadId, h.cursor);
      this.check(data);
      if (verify.busy || hash(verify.cursor) !== hash(delta.cursor) || this.row(id).revision !== revision) return fail("提交前双端状态发生变化，请重新核对");
      this.db.exec("BEGIN IMMEDIATE");
      try {
        await this.engine.canonicalEngine.store.commit({ kind: "dsh-append", operationId: null,
          session: { ...p.snapshot.session, headVersionId: version.id, updatedAt: at }, version,
          membership: null, derivation: null, projectionReceipt: null, tombstone: null, observation: null,
          receipt: { outcome: "advanced", operationId: null, logicalSessionId: p.snapshot.session.id, versionId: version.id, tombstoneState: null, committedAt: at } });
        h.consumed = true; this.db.prepare("UPDATE learning_handoffs SET data_json=? WHERE id=?").run(JSON.stringify(h), data.handoffId);
        data.cursor = delta.cursor; data.syncedMessages = [...data.syncedMessages, ...contents(delta.messages)]; data.state = "collected"; data.collectedAt = at;
        data.message = `已回收 ${delta.messages.length} 条问答，重新启动 DSH 后继续原会话`; this.save(data); this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      return this.public(id);
    }, signal);
  }
  async disable(id: string, signal?: AbortSignal) {
    return this.write(async () => { const { data } = this.row(id); data.state = "disabled"; data.message = "已停用，学习正文及历史交接记录保留"; this.save(data); return this.public(id); }, signal);
  }
  async verifySend(id: string, signal?: AbortSignal) {
    return this.write(async () => {
      const { data, revision } = this.row(id); this.check(data);
      if (!["sending", "uncertain"].includes(data.state) || !data.handoffId) return fail("没有需要核验的同步");
      const row = this.db.prepare("SELECT data_json FROM learning_handoffs WHERE id=?").get(data.handoffId) as { data_json: string };
      const pending = JSON.parse(row.data_json) as { revision: number; before: LearningCursor; pendingMessages: unknown[]; syncedMessages: Stored["syncedMessages"] };
      if (pending.revision !== revision) return fail("DSH 在中断后发生变化，禁止自动确认");
      const observed = await this.codex.read(this.target(data.targetPresetId), data.codexThreadId, pending.before);
      if (observed.busy || hash(contents(observed.messages)) !== hash(pending.pendingMessages)) return fail("无法精确核对注入结果，保留现状；请勿再次注入");
      const sentAt = this.now();
      const h: Handoff = { revision, cursor: observed.cursor, sentAt, endpointDigest: data.endpointDigest, consumed: false };
      data.state = "sent"; data.sentAt = sentAt; data.cursor = observed.cursor; data.syncedMessages = pending.syncedMessages;
      data.message = "已核验送达，请重新启动 Codex 后继续学习";
      this.db.exec("BEGIN IMMEDIATE");
      try { this.db.prepare("UPDATE learning_handoffs SET data_json=? WHERE id=?").run(JSON.stringify(h), data.handoffId); this.save(data); this.db.exec("COMMIT"); }
      catch (error) { this.db.exec("ROLLBACK"); throw error; }
      return this.public(id);
    }, signal);
  }
  async revalidate(id: string, signal?: AbortSignal) {
    return this.write(async () => {
      const { data } = this.row(id), target = this.target(data.targetPresetId);
      // Explicit revalidation invalidates the old handoff; no archived/deleted source is revived.
      const row = this.db.prepare(`SELECT r.id,p.native_session_id FROM projection_runs r JOIN projection_sessions p ON p.run_id=r.id
        WHERE p.logical_session_id=? AND r.instance_id=? AND r.profile_id=? ORDER BY r.started_at DESC LIMIT 1`)
        .get(data.logicalSessionId, data.dshInstanceId, data.dshProfileId) as { id: string; native_session_id: string } | undefined;
      if (!row || target.codexInstanceId !== data.codexInstanceId) return fail("端点身份无法核验，不能按标题迁移关联");
      data.dshRunId = row.id; data.dshNativeSessionId = row.native_session_id; data.endpointDigest = this.endpoint(target); this.check(data);
      const p = await this.projection(data), observed = await this.codex.read(target, data.codexThreadId);
      if (observed.busy || !prefix(contents(observed.messages), contents(p.prepared.messages))) return fail("双端历史已有分歧，请先核对内容；不会自动合并");
      data.cursor = observed.cursor; data.syncedMessages = contents(observed.messages); data.handoffId = null;
      data.state = "ready"; data.message = "关联已重新核验，旧交接失效，请重新同步"; this.save(data);
      return this.public(id);
    }, signal);
  }
}
