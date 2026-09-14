import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SessionContextEntry, SessionContextPage, SessionContextRecord } from "@linmu/dsh-session-contracts";

/** One execution shares its allowance across references, searches, retries and concurrent calls. */
export class ContextReadBudgets {
  constructor(private readonly database: DatabaseSync) {}
  private transaction<T>(work:()=>T):T {
    this.database.exec('SAVEPOINT context_budget');
    try{const result=work();this.database.exec('RELEASE context_budget');return result;}
    catch(error){this.database.exec('ROLLBACK TO context_budget; RELEASE context_budget');throw error;}
  }
  reserve(key: string, limit: number, requested: number, runId='test'): { bytes: number; settle: (used: number) => number } {
    const digest=createHash('sha256').update(key).digest('hex');
    const bytes=this.transaction(()=>{
      this.database.prepare("INSERT OR IGNORE INTO context_read_executions VALUES(?,?,'active',0,?)").run(digest,runId,limit);
      const entry=this.database.prepare('SELECT * FROM context_read_executions WHERE execution_key=?').get(digest)!;
      if(entry.state!=='active'||entry.run_id!==runId)throw new Error('本轮引用读取已经结束；不能重放已完成执行');
      const nextLimit=Math.min(Number(entry.limit_bytes),limit),available=Math.max(0,Math.min(requested,nextLimit-Number(entry.used_bytes)));
      this.database.prepare('UPDATE context_read_executions SET used_bytes=used_bytes+?,limit_bytes=? WHERE execution_key=?').run(available,nextLimit,digest);
      return available;
    });
    let settled = false;
    return { bytes, settle: used => {
      if (settled || used < 0 || used > bytes) throw new Error("Invalid context budget settlement");
      settled = true;return this.transaction(()=>{
        const entry=this.database.prepare('SELECT state FROM context_read_executions WHERE execution_key=?').get(digest);
        if(entry?.state!=='active')throw new Error('本轮引用读取已经结束');
        this.database.prepare('UPDATE context_read_executions SET used_bytes=used_bytes-? WHERE execution_key=?').run(bytes-used,digest);
        const remaining=this.database.prepare('SELECT limit_bytes-used_bytes remaining FROM context_read_executions WHERE execution_key=?').get(digest)!;
        return Math.max(0,Number(remaining.remaining));
      });
    } };
  }
  end(key:string,runId:string):void {
    const digest=createHash('sha256').update(key).digest('hex');
    // Retain only a compact replay tombstone until the owning run has terminated.
    this.database.prepare("INSERT INTO context_read_executions VALUES(?,?,'closed',0,0) ON CONFLICT(execution_key) DO UPDATE SET state='closed',used_bytes=0,limit_bytes=0").run(digest,runId);
  }
  cleanup():void {
    this.database.exec("DELETE FROM context_read_executions WHERE run_id IN (SELECT id FROM projection_runs WHERE state IN ('closed','recovered','quarantined'))");
  }
}
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const key = (r: SessionContextRecord, query?: string) => createHash("sha256").update(JSON.stringify([r.referenceId,r.sourceVersionId,r.cutoffEventId,query ?? null])).digest("hex").slice(0,24);

/** Pure pagination; every character of a long message remains reachable by a cursor. */
export function readContextPage(record: SessionContextRecord, entries: readonly SessionContextEntry[], maxBytes: number,
  cursor?: string, query?: string, selectedTurnStartEventId?: string, selectedReplyEventId?: string): SessionContextPage {
  let index = entries.length - 1, offset = 0;
  let turnStart: number | undefined;
  let replyIndex: number | undefined;
  if (selectedTurnStartEventId !== undefined) {
    if (cursor || query) throw new Error("首轮上下文不能同时指定游标或搜索词");
    turnStart = entries.findIndex(entry => entry.eventId === selectedTurnStartEventId);
    if (turnStart < 0) throw new Error("来源轮次起点不可用");
    index = turnStart;
    if (selectedReplyEventId !== undefined) {
      replyIndex = entries.findIndex(entry => entry.eventId === selectedReplyEventId);
      if (replyIndex < turnStart) throw new Error("来源问答的回复位置不可用");
    }
  }
  const fingerprint = key(record, query);
  if (cursor) {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || ![3,5,6].includes(parsed.length) || parsed[0] !== fingerprint
      || !Number.isSafeInteger(parsed[1]) || !Number.isSafeInteger(parsed[2]) || parsed[1] < 0 || parsed[1] >= entries.length || parsed[2] < 0
      || parsed[2] > entries[parsed[1]]!.text.length) throw new Error("引用读取游标无效");
    [index, offset] = [parsed[1], parsed[2]];
    if (parsed.length >= 5) {
      if (query || parsed[3] !== 'selected-turn' || !Number.isSafeInteger(parsed[4]) || parsed[4] < 0 || parsed[4] > index)
        throw new Error("引用读取游标无效");
      turnStart = parsed[4];
      if (parsed.length === 6) {
        if (!Number.isSafeInteger(parsed[5]) || parsed[5] < parsed[4] || parsed[5] >= entries.length) throw new Error("引用读取游标无效");
        replyIndex = parsed[5];
      }
    }
  }
  // Initial turn material is embedded in an annotation envelope. Account for
  // escaping tag characters as well as ordinary JSON; plain tool reads stay unchanged.
  const measure = turnStart === undefined ? size : (value: unknown) => Buffer.byteLength(
    JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4,'0')}`));
  const page: SessionContextPage = { referenceId:record.referenceId,sourceSessionId:record.sourceSessionId,
    sourceVersionId:record.sourceVersionId,cutoffEventId:record.cutoffEventId,items:[],nextCursor:null,hasMore:false,
    remainingBytes:0,budgetExhausted:false, ...(turnStart === undefined ? {} : {selectedTurn:{complete:false}}) };
  const included = (position: number) => replyIndex === undefined || position === replyIndex || entries[position]!.role === 'user';
  if (turnStart !== undefined && replyIndex !== undefined) {
    const omitted = entries.map((entry,position)=>({entry,position})).filter(({entry,position})=>position>=turnStart!&&!included(position)&&entry.text.length>0);
    page.selectedTurn!.omittedIntermediateItems = omitted.length;
    const latest = omitted.at(-1);
    if (latest) page.selectedTurn!.detailsCursor = Buffer.from(JSON.stringify([fingerprint,latest.position,0])).toString('base64url');
  }
  // Leave headroom for cursor, allowance and surrounding JSON fields.
  const contentLimit = Math.max(0, maxBytes - measure(page) - 512);
  let used = 0;
  const direction = turnStart === undefined ? -1 : 1;
  while (index >= 0 && index < entries.length) {
    const entry = entries[index]!;
    if (!included(index)) { index+=direction; offset=0; continue; }
    // Empty model-visible content (for example, stripped reasoning) and an
    // exhausted message cursor must advance to older material, not repeat.
    if (offset >= entry.text.length) { index+=direction; offset=0; continue; }
    const start = query ? entry.text.toLowerCase().indexOf(query.toLowerCase(), offset) : offset;
    if (start < 0) { index--; offset=0; continue; }
    const begin = query ? start : offset;
    let low = 0, high = Math.min(entry.text.length - begin, query ? 600 : entry.text.length);
    const item: SessionContextPage['items'][number] = { eventId:entry.eventId,role:entry.role,text:"",offset:begin,complete:false,
      ...(query ? { readCursor: Buffer.from(JSON.stringify([key(record),index,Math.max(0,start-150)])).toString('base64url') } : {}) };
    while (low < high) {
      const n = Math.ceil((low + high) / 2);
      if (measure({...item,text:entry.text.slice(begin,begin+n)}) <= contentLimit - used) low=n; else high=n-1;
    }
    if (low === 0) break;
    // Avoid splitting surrogate pairs; next cursor resumes exactly after the returned fragment.
    if (/[\uD800-\uDBFF]/u.test(entry.text.charAt(begin+low-1))) low--;
    if (low === 0) break;
    item.text=entry.text.slice(begin,begin+low);item.complete=begin+low===entry.text.length;
    page.items.push(item);used+=measure(item);
    if (item.complete) { index+=direction;offset=0; }
    else if (query) { offset = start + Math.max(query.length, low); }
    else { offset=begin+low;break; }
    if (page.items.length >= 20) break;
  }
  if (turnStart !== undefined && index >= entries.length) {
    page.selectedTurn!.complete = true;
    index = turnStart - 1; offset = 0;
    // Do not eagerly consume earlier turns, even when space remains on this page.
    turnStart = undefined;
  }
  page.hasMore=index>=0;
  page.nextCursor=page.hasMore?Buffer.from(JSON.stringify([fingerprint,index,offset,
    ...(turnStart === undefined ? [] : ['selected-turn',turnStart,...(replyIndex === undefined ? [] : [replyIndex])])])).toString("base64url"):null;
  page.budgetExhausted=page.hasMore&&page.items.length===0;
  if (measure(page)>maxBytes) throw new Error("引用结果的最小描述超过剩余预算");
  return page;
}
