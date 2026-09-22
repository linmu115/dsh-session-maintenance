import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { readStoredReaderPresentation, READER_METADATA_COLUMNS, READER_EVENT_TEXT_SQL, READER_EVENT_SOURCE_SQL, type ReaderStoredMetadata } from "@linmu/dsh-session-adapter-0-1-5";
import type { ReaderEventPage, ReaderEventQuery, ReaderMessage, ReaderProcessItem, ReaderProcessKind, ReaderProcessPage, ReaderProcessQuery, ReaderTurn, SessionReaderPage, SessionReaderQuery } from "@linmu/dsh-session-contracts";

export class SessionReaderError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
type Meta = ReaderStoredMetadata;
type Classified = Meta & { presentation: ReturnType<typeof readStoredReaderPresentation> };
interface TurnIndex { id: string; ordinal: number; start: number; end: number; user?: Classified; answer?: Classified; count: number; kinds: Map<ReaderProcessKind, { label: string; count: number }> }

// Only scalar attribution fields cross the SQLite boundary. Neither source.sections
// nor tool arguments/results nor the complete canonical JSON enter a list response.
const META = `SELECT ${READER_METADATA_COLUMNS} FROM ${READER_EVENT_SOURCE_SQL} WHERE logical_session_id = ?`;

function classify(row: Meta, sessionId: string): Classified {
  return { ...row, presentation: readStoredReaderPresentation(row, sessionId) };
}
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) throw new SessionReaderError(400, "READER_RANGE", "读取数量超出范围。");
  return n;
}
function cursor(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new SessionReaderError(400, "READER_CURSOR", "读取位置无效。");
  return Number(value);
}
function processKind(row: Classified): ReaderProcessKind {
  if (row.kind === 'opaque-unknown' || row.kind === 'other') return 'opaque-data';
  return row.presentation.kind === "user" ? "record" : row.presentation.kind;
}
function addProcess(turn: TurnIndex, row: Classified) {
  const kind = processKind(row), label = kind === 'opaque-data' ? '未识别数据包' : kind === "assistant" ? "中间回复" : row.presentation.label;
  const current = turn.kinds.get(kind) ?? { label, count: 0 };
  current.count++; turn.kinds.set(kind, current); turn.count++;
}

/** Query-only reader over saved Maintenance tables; no history cache or source writes. */
export class SessionReaderQueries {
  constructor(readonly database: DatabaseSync) {}
  snapshot(sessionId: string, expected?: string): string {
    const row = this.database.prepare(`SELECT head_version_id AS head FROM logical_sessions WHERE id=? AND authority_scope IS NOT NULL`).get(sessionId) as { head: string | null } | undefined;
    if (!row) throw new SessionReaderError(404, "READER_SESSION_NOT_FOUND", "会话不存在。");
    const revision = this.database.prepare(`SELECT COALESCE(MAX(revision),0) AS revision FROM canonical_change_log WHERE logical_session_id=?`).get(sessionId);
    const last = this.database.prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(sequence),-1) AS last FROM canonical_events WHERE logical_session_id=?`).get(sessionId);
    const value = createHash("sha256").update(JSON.stringify({ sessionId, head: row.head, revision, last })).digest("hex");
    if (expected !== undefined && expected !== value) throw new SessionReaderError(409, "READER_SNAPSHOT_CHANGED", "会话已有更新，请重新加载后继续阅读。");
    return value;
  }
  private *turns(sessionId: string): Generator<TurnIndex> {
    let turn: TurnIndex | undefined, ordinal = 0;
    let pending: Classified[] = [];
    for (const value of this.database.prepare(`${META} ORDER BY sequence,id`).iterate(sessionId)) {
      const row = classify(value as unknown as Meta, sessionId);
      if (turn?.answer && ["runtime-context", "skill-catalog", "plugin-context"].includes(row.presentation.kind)) { pending.push(row); continue; }
      if (row.presentation.kind === "user" && turn && (turn.user || turn.answer)) { yield turn; turn = undefined; }
      const start = pending[0]?.sequence ?? row.sequence;
      turn ??= { id: `turn-${start}`, ordinal: ++ordinal, start, end: row.sequence, count: 0, kinds: new Map() };
      for (const context of pending) { addProcess(turn, context); turn.end = context.sequence; }
      pending = [];
      turn.end = row.sequence;
      if (row.presentation.kind === "user") turn.user = row;
      else if (row.presentation.kind === "assistant" && row.has_text === 1) {
        if (turn.answer) addProcess(turn, turn.answer);
        turn.answer = row;
      } else addProcess(turn, row);
    }
    if (turn) { for (const context of pending) { addProcess(turn, context); turn.end = context.sequence; } yield turn; }
  }
  private turn(sessionId: string, turnId: string): TurnIndex {
    for (const turn of this.turns(sessionId)) if (turn.id === turnId) return turn;
    throw new SessionReaderError(404, "READER_TURN_NOT_FOUND", "该轮记录不存在。");
  }
  event(sessionId: string, eventId: string, query: ReaderEventQuery): ReaderEventPage {
    const snapshot = this.snapshot(sessionId, query.snapshot), limit = bounded(query.limit, 8192, 16384), offset = cursor(query.offset?.toString());
    const format = query.format ?? "text";
    const expression = format === "raw" ? "event_json" : READER_EVENT_TEXT_SQL;
    const row = this.database.prepare(`SELECT length(body) AS total, substr(body,?,?) AS text FROM
      (SELECT ${expression} AS body FROM ${READER_EVENT_SOURCE_SQL} WHERE logical_session_id=? AND id=?)`).get(offset + 1, limit, sessionId, eventId) as { total: number; text: string } | undefined;
    if (!row) throw new SessionReaderError(404, "READER_EVENT_NOT_FOUND", "该记录不存在。");
    if (offset > row.total) throw new SessionReaderError(400, "READER_RANGE", "读取位置超出记录末尾。");
    return { schemaVersion: 1, snapshot, eventId, format, text: row.text, offset, totalChars: row.total,
      nextOffset: offset + limit < row.total ? offset + limit : null };
  }
  page(sessionId: string, query: SessionReaderQuery): Pick<SessionReaderPage, "schemaVersion" | "snapshot" | "turns" | "nextCursor"> {
    const snapshot = this.snapshot(sessionId, query.snapshot), start = cursor(query.cursor), limit = bounded(query.limit, 6, 10);
    const turns: ReaderTurn[] = []; let nextCursor: string | null = null;
    for (const turn of this.turns(sessionId)) {
      if (turn.start < start) continue;
      if (turns.length === limit) { nextCursor = String(turn.start); break; }
      const messages: ReaderMessage[] = [];
      for (const item of [turn.user, turn.answer]) if (item) {
        const page = this.event(sessionId, item.id, { snapshot, limit: 4096 });
        messages.push({ eventId: item.id, role: item.presentation.kind === "user" ? "user" : "assistant", text: page.text, totalChars: page.totalChars, nextOffset: page.nextOffset });
      }
      turns.push({ id: turn.id, ordinal: turn.ordinal, messages, processCount: turn.count,
        processKinds: [...turn.kinds].map(([kind, entry]) => ({ kind, ...entry })) });
    }
    return { schemaVersion: 1, snapshot, turns, nextCursor };
  }
  process(sessionId: string, query: ReaderProcessQuery): ReaderProcessPage {
    const snapshot = this.snapshot(sessionId, query.snapshot), start = cursor(query.cursor), limit = bounded(query.limit, 25, 50), turn = this.turn(sessionId, query.turnId);
    const items: ReaderProcessItem[] = [], pairs = new Map<string, number>();
    let opaqueIndex: number | undefined;
    for (const value of this.database.prepare(`${META} AND sequence>=? AND sequence<=? ORDER BY sequence,id`).iterate(sessionId, turn.start, turn.end)) {
      const row = classify(value as unknown as Meta, sessionId);
      if (row.id === turn.user?.id || row.id === turn.answer?.id) continue;
      const kind = processKind(row), callId = row.presentation.toolCallId;
      if (kind === 'opaque-data') {
        if (opaqueIndex === undefined) {
          opaqueIndex = items.length;
          items.push({ id: `opaque-${row.id}`, kind, label: '未识别数据包', eventIds: [row.id], paired: false });
        } else {
          const previous = items[opaqueIndex]!;
          items[opaqueIndex] = { ...previous, eventIds: [...previous.eventIds, row.id] };
        }
        continue;
      }
      if (kind === "tool-result" && callId && pairs.has(callId)) {
        const index = pairs.get(callId)!, prior = items[index]!;
        items[index] = { ...prior, eventIds: [...prior.eventIds, row.id], paired: true }; pairs.delete(callId); continue;
      }
      if (kind === "tool-call" && callId) pairs.set(callId, items.length);
      items.push({ id: row.id, kind, label: kind === "assistant" ? "中间回复" : row.presentation.toolName ? `${row.presentation.label} · ${row.presentation.toolName}` : row.presentation.label, eventIds: [row.id], paired: false });
    }
    return { schemaVersion: 1, snapshot, turnId: turn.id, items: items.slice(start, start + limit), nextCursor: start + limit < items.length ? String(start + limit) : null };
  }
}
