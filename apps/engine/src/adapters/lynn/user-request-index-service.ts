import { createHash } from "node:crypto";
import {
  ExtensionDataError, userRequestListSchema, userRequestLocateSchema, userRequestSessionListSchema,
  type CanonicalEventV1, type LogicalSessionId, type RunId, type SessionVersionId,
  type UserRequestEntry, type UserRequestList, type UserRequestLocate,
  type UserRequestLocated, type UserRequestLocation, type UserRequestPage, type UserRequestSessionList,
} from "@linmu/dsh-session-contracts";
import { buildDshUserRequestIndex, readDshUserRequestText, type DshUserRequestIndexEntry } from "@linmu/dsh-session-adapter-0-1-5";
import type { SessionMaintenanceEngine } from "../../engine.js";
import { ContextReadBudgets } from "./session-context-reader.js";

const fail = (code: string, message: string, status = 409): never => { throw new ExtensionDataError(code, message, status); };
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
type ScopeInput = Pick<UserRequestList, "runId" | "targetNativeSessionId" | "executionId" | "referenceId">;
interface Source {
  snapshot: string; targetSessionId: string; logicalSessionId: string; sourceVersionId: string;
  referenceId: string | null; cutoffEventId: string | null; events: readonly CanonicalEventV1[];
  /** Capture resolution again immediately before returning any bytes. */
  verify: () => Promise<void>;
}
type Cursor = { v: 1; s: string; m: "list" | "text"; i: number; r: string | null };
type PageInput = Pick<ReturnType<typeof userRequestListSchema.parse>, "requestId" | "cursor" | "limit" | "maxBytes" | "totalBytes">;

function readCursor(value: string | undefined, snapshot: string, requestId?: string): Cursor {
  const fallback: Cursor = { v: 1, s: snapshot, m: requestId ? "text" : "list", i: 0, r: requestId ?? null };
  if (!value) return fallback;
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { return fail("REQUEST_CURSOR_INVALID", "请求目录游标无效", 400); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail("REQUEST_CURSOR_INVALID", "请求目录游标无效", 400);
  const candidate = parsed as Partial<Cursor>;
  if (candidate.v !== 1 || candidate.m !== fallback.m || candidate.r !== fallback.r
    || !Number.isSafeInteger(candidate.i) || candidate.i! < 0) return fail("REQUEST_CURSOR_INVALID", "请求目录游标不属于本次读取", 400);
  if (candidate.s !== snapshot) return fail("REQUEST_SNAPSHOT_CHANGED", "来源版本、授权或暂停状态已变化，请重新读取请求目录");
  return candidate as Cursor;
}

/** Immutable canonical requests, scoped to the current execution or one authorized upstream. */
export class UserRequestIndexService {
  private budgetStore?: ContextReadBudgets;
  private get budgets() { return this.budgetStore ??= new ContextReadBudgets(this.engine.repository.database); }
  constructor(private readonly engine: SessionMaintenanceEngine) {}

  private async current(input: ScopeInput) {
    const run = await this.engine.projectionRunRepository.getProjectionRun(input.runId as RunId);
    if (!run || run.state !== "running" || !["dsh-0.1.5"].includes(run.adapterId))
      return fail("REQUEST_SCOPE_UNAVAILABLE", "当前运行尚未就绪或不支持原生请求索引");
    const identity = this.engine.sessionQueries.resolveProjectionSessionIdentity(input.runId, input.targetNativeSessionId);
    if (!identity || identity.status !== "active") return fail("REQUEST_SCOPE_UNAVAILABLE", "会话未接入当前运行");
    const mode = this.engine.repository.database.prepare("SELECT mode FROM projection_sessions WHERE run_id=? AND native_session_id=?")
      .get(input.runId, input.targetNativeSessionId) as { mode: string } | undefined;
    const state = this.engine.repository.database.prepare("SELECT archived,archived_at,tombstoned_at FROM logical_sessions WHERE id=?")
      .get(identity.logicalSessionId) as { archived: number; archived_at: string | null; tombstoned_at: string | null } | undefined;
    if (!mode || ["hidden", "recovery-only"].includes(mode.mode) || !state || state.archived || state.archived_at || state.tombstoned_at)
      return fail("REQUEST_SCOPE_UNAVAILABLE", "当前会话已归档、删除或未启用");
    return { run, logicalSessionId: identity.logicalSessionId };
  }

  private async source(input: ScopeInput): Promise<Source> {
    const target = await this.current(input);
    if (input.referenceId) {
      const referenceId = input.referenceId;
      const access = await this.engine.sessionContext.record(input.runId, input.targetNativeSessionId, referenceId);
      const usage = await this.engine.nativeContext.assertReferenceReadable(input.runId, input.targetNativeSessionId, referenceId);
      const { events, index } = await this.engine.sessionContext.source(access.record, access.run.adapterId);
      // Filtering precedes request classification, association, counts and cursors.
      const fixed = events.slice(0, index + 1);
      const snapshot = fingerprint([input.runId, target.logicalSessionId, access.record.sourceSessionId,
        access.record.sourceVersionId, access.record.cutoffEventId, access.record.cutoffDigest, access.object.revision, usage.revision]);
      return { snapshot, targetSessionId: target.logicalSessionId, logicalSessionId: access.record.sourceSessionId,
        sourceVersionId: access.record.sourceVersionId, referenceId, cutoffEventId: access.record.cutoffEventId, events: fixed,
        verify: async () => {
          await this.current(input);
          const latest = await this.engine.sessionContext.record(input.runId, input.targetNativeSessionId, referenceId);
          const currentUsage = await this.engine.nativeContext.assertReferenceReadable(input.runId, input.targetNativeSessionId, referenceId);
          if (latest.object.revision !== access.object.revision || currentUsage.revision !== usage.revision
            || latest.record.sourceVersionId !== access.record.sourceVersionId || latest.record.cutoffEventId !== access.record.cutoffEventId)
            fail("REQUEST_SNAPSHOT_CHANGED", "引用在请求目录读取期间发生变化，请重试");
          if (!this.engine.repository.database.prepare("SELECT 1 FROM session_versions WHERE id=? AND logical_session_id=?")
            .get(access.record.sourceVersionId, access.record.sourceSessionId))
            fail("REQUEST_SOURCE_UNAVAILABLE", "来源版本已清理，不能继续披露请求目录");
        } };
    }
    const session = await this.engine.canonicalEngine.store.getSession(target.logicalSessionId as LogicalSessionId);
    const versionId = session?.headVersionId;
    const version = versionId ? await this.engine.canonicalEngine.store.getVersion(versionId as SessionVersionId) : undefined;
    if (!version || version.logicalSessionId !== target.logicalSessionId)
      return fail("REQUEST_SOURCE_UNAVAILABLE", "当前会话尚无可读取的持久历史");
    const snapshot = fingerprint([input.runId, target.logicalSessionId, version.id]);
    return { snapshot, targetSessionId: target.logicalSessionId, logicalSessionId: target.logicalSessionId,
      sourceVersionId: version.id, referenceId: null, cutoffEventId: version.events.at(-1)?.id ?? null, events: version.events,
      verify: async () => {
        await this.current(input);
        const latest = await this.engine.canonicalEngine.store.getSession(target.logicalSessionId as LogicalSessionId);
        if (latest?.headVersionId !== version.id) fail("REQUEST_SNAPSHOT_CHANGED", "会话已有持久更新，请重新读取请求目录");
      } };
  }

  private index(source: Source) {
    return buildDshUserRequestIndex(source.events, source.referenceId && source.cutoffEventId
      ? { completedCutoffEventId: source.cutoffEventId } : {});
  }
  private location(source: Source, entry: DshUserRequestIndexEntry): UserRequestLocation {
    return { requestEventId: entry.eventId, startEventId: entry.startEventId, endEventId: entry.endEventId,
      replyEventId: entry.replyEventId, rangeState: entry.rangeState,
      readCursor: encode(["request-location-v1", source.snapshot, entry.requestId]) };
  }

  /** Internal navigation for window/upstream services; returns identities only. */
  async locate(request: UserRequestLocate): Promise<UserRequestLocated> {
    const input = userRequestLocateSchema.parse(request), source = await this.source(input);
    if (input.snapshot !== undefined && input.snapshot !== source.snapshot)
      return fail("REQUEST_SNAPSHOT_CHANGED", "请求定位属于旧版本或旧授权，请重新读取目录");
    const entry = this.index(source).find(item => item.requestId === input.requestId);
    if (!entry || entry.sourceTrust !== "verified") return fail("REQUEST_NOT_AVAILABLE", "该请求不在当前授权范围内，或提交来源尚待核验");
    await source.verify();
    return { schemaVersion: 1, snapshot: source.snapshot, logicalSessionId: source.logicalSessionId,
      sourceVersionId: source.sourceVersionId, referenceId: source.referenceId, cutoffEventId: source.cutoffEventId,
      requestId: entry.requestId, location: this.location(source, entry) };
  }

  async list(request: UserRequestList, options: { preview?: boolean } = {}): Promise<UserRequestPage> {
    const input = userRequestListSchema.parse(request), source = await this.source(input);
    // This flag is an in-process capability, never accepted from the model DTO.
    // The authenticated UI route supplies it only for actor=user.
    if (options.preview === true) return this.page({ ...input, totalBytes: input.maxBytes }, source,
      { bytes: input.maxBytes, settle: used => Math.max(0, input.maxBytes - used) }, false);
    this.budgets.cleanup();
    let reservation: ReturnType<ContextReadBudgets["reserve"]>;
    try { reservation = this.budgets.reserve(JSON.stringify([input.runId, source.targetSessionId, input.executionId]), input.totalBytes, input.maxBytes, input.runId); }
    catch (error) { return fail("REQUEST_BUDGET_UNAVAILABLE", error instanceof Error ? error.message : "读取预算不可用"); }
    return this.page(input, source, reservation, true);
  }

  /** Dashboard read-only access also works while no DSH runtime is running. */
  async listSession(request: UserRequestSessionList): Promise<UserRequestPage> {
    const input = userRequestSessionListSchema.parse(request);
    const session = await this.engine.canonicalEngine.store.getSession(input.logicalSessionId as LogicalSessionId);
    const versionId = session?.headVersionId;
    const version = versionId ? await this.engine.canonicalEngine.store.getVersion(versionId) : undefined;
    if (!version || version.logicalSessionId !== input.logicalSessionId)
      return fail("REQUEST_SOURCE_UNAVAILABLE", "该会话尚无可读取的持久历史", 404);
    const snapshot = fingerprint(["dashboard", input.logicalSessionId, version.id]);
    const source: Source = { snapshot, targetSessionId: input.logicalSessionId, logicalSessionId: input.logicalSessionId,
      sourceVersionId: version.id, referenceId: null, cutoffEventId: version.events.at(-1)?.id ?? null, events: version.events,
      verify: async () => {
        const latest = await this.engine.canonicalEngine.store.getSession(input.logicalSessionId as LogicalSessionId);
        if (latest?.headVersionId !== version.id) fail("REQUEST_SNAPSHOT_CHANGED", "会话已有更新，请重新加载请求目录");
      } };
    return this.page({ ...input, totalBytes: input.maxBytes }, source,
      { bytes: input.maxBytes, settle: used => Math.max(0, input.maxBytes - used) }, false);
  }

  private async page(input: PageInput, source: Source, reservation: ReturnType<ContextReadBudgets["reserve"]>, executionBudget: boolean): Promise<UserRequestPage> {
    let settled = false;
    try {
      const cursor = readCursor(input.cursor, source.snapshot, input.requestId), index = this.index(source);
      const chosen = input.requestId ? index.filter(item => item.requestId === input.requestId) : index;
      if (input.requestId && chosen.length === 0) return fail("REQUEST_NOT_AVAILABLE", "请求不在本次固定版本与授权范围内");
      if (cursor.m === "list" && cursor.i > chosen.length) return fail("REQUEST_CURSOR_INVALID", "请求目录位置超出末尾", 400);
      const page: UserRequestPage = { schemaVersion: 1, snapshot: source.snapshot, logicalSessionId: source.logicalSessionId,
        sourceVersionId: source.sourceVersionId, referenceId: source.referenceId, cutoffEventId: source.cutoffEventId,
        directoryOnly: true, items: [], nextCursor: null, hasMore: false, remainingBytes: input.totalBytes, budgetExhausted: false };
      let position = cursor.m === "list" ? cursor.i : 0;
      const eventMap = new Map(source.events.map(event => [event.id, event]));
      while (position < chosen.length && page.items.length < input.limit) {
        const entry = chosen[position]!, offset = cursor.m === "text" ? cursor.i : 0;
        if (entry.sourceTrust === "unverified" && (input.requestId || offset))
          return fail("REQUEST_SOURCE_UNVERIFIED", "旧消息的提交来源尚待核验，不能作为用户请求原文披露");
        const event = eventMap.get(entry.eventId)!;
        const text = entry.sourceTrust === "verified" ? readDshUserRequestText(event, offset, cursor.m === "text" ? 16000 : 384)
          : { text: "", totalChars: 0, nextOffset: null };
        const characters = [...text.text];
        const make = (length: number): UserRequestEntry => {
          const nextOffset = offset + length < text.totalChars ? offset + length : null;
          return { requestId: entry.requestId, eventId: entry.eventId, nativeMessageId: entry.nativeMessageId, ordinal: entry.ordinal,
            createdAt: entry.createdAt, text: characters.slice(0, length).join(""), totalChars: text.totalChars, textOffset: offset,
            nextTextCursor: nextOffset === null ? null : encode({ v: 1, s: source.snapshot, m: "text", i: nextOffset, r: entry.requestId }),
            sourceTrust: entry.sourceTrust, attachmentRefs: entry.attachmentRefs, attachmentsOmitted: entry.attachmentsOmitted,
            executionRefs: entry.executionRefs, replyRefs: entry.replyRefs, replyRefsOmitted: entry.replyRefsOmitted,
            turnId: entry.turnId, turnBoundaryEventId: entry.turnBoundaryEventId, relation: entry.relation, state: entry.state,
            associationState: entry.associationState, location: entry.sourceTrust === "verified" ? this.location(source, entry) : null };
        };
        const nextList = position + 1 < chosen.length ? encode({ v: 1, s: source.snapshot, m: "list", i: position + 1, r: null }) : null;
        const withItem = (item: UserRequestEntry): UserRequestPage => ({ ...page, items: [...page.items, item],
          nextCursor: cursor.m === "text" ? item.nextTextCursor : nextList,
          hasMore: cursor.m === "text" ? item.nextTextCursor !== null : nextList !== null });
        let low = 0, high = characters.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (bytes(withItem(make(middle))) <= reservation.bytes) low = middle; else high = middle - 1;
        }
        const item = make(low), candidate = withItem(item);
        if (bytes(candidate) > reservation.bytes || (characters.length > 0 && low === 0)) {
          if (page.items.length === 0) return fail("REQUEST_BUDGET_EXHAUSTED", "剩余读取预算不足以返回请求条目，请使用已取得的材料");
          break;
        }
        page.items = candidate.items; page.nextCursor = candidate.nextCursor; page.hasMore = candidate.hasMore;
        position++;
        if (cursor.m === "text") break;
      }
      // When byte capacity stops a list, its next cursor still points to the
      // first unreturned request, never over an omitted item.
      if (cursor.m === "list" && position < chosen.length) {
        page.nextCursor = encode({ v: 1, s: source.snapshot, m: "list", i: position, r: null }); page.hasMore = true;
      }
      if (bytes(page) > reservation.bytes) return fail("REQUEST_BUDGET_EXHAUSTED", "本轮请求目录读取预算已用完");
      await source.verify();
      page.remainingBytes = reservation.settle(bytes(page)); settled = true;
      page.budgetExhausted = executionBudget && page.remainingBytes < 2048;
      return page;
    } finally { if (!settled) try { reservation.settle(0); } catch { /* Execution already ended. */ } }
  }
}
