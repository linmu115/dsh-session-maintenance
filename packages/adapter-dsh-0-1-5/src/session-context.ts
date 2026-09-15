import { canonicalEventProjectionPolicy, readCanonicalConversationTopologyV1, type SessionContextAdapter, type CanonicalEventV1, type JsonValue } from "@linmu/dsh-session-contracts";
import { digest, isRecord, record } from "./common.js";
import { v3ProjectedNativeRevision } from "./materialize.js";
import { readDshReaderPresentation } from "./reader-presentation.js";

function referenceText(content: JsonValue): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(block => {
    if (!isRecord(block)) return JSON.stringify(block);
    if (block.type === 'text') return typeof block.text === 'string' ? block.text : '';
    if (block.type === 'reasoning') return '';
    if (['image','file','audio','video'].includes(String(block.type)))
      return JSON.stringify({type:block.type,name:typeof block.name==='string'?block.name:null,content:'附件正文未展开'});
    return JSON.stringify(block);
  }).filter(Boolean).join('\n');
  if (isRecord(content) && typeof content.text === 'string') return content.text;
  return JSON.stringify(content);
}

/** RC2's completed assistant identity and its conversion receipt define the cut. */
export const v3SessionContext: SessionContextAdapter = {
  selectedReply(events) {
    const visible = new Set(this.entries(events).map(entry => entry.eventId));
    const reply = events.findLast(event => event.kind === 'assistant-message' && visible.has(event.id));
    if (!reply) throw new Error("被引用回复没有可读取的正文");
    return reply.id;
  },
  selectedTurnStart(events) {
    const last = events.at(-1);
    if (!last) throw new Error("来源轮次不可用");
    const topology = readCanonicalConversationTopologyV1(last);
    let start: number;
    if (topology) {
      start = events.findIndex(event => readCanonicalConversationTopologyV1(event)?.turnId === topology.turnId);
    } else {
      // Native RC2 records the boundary separately from its user messages.
      start = events.findLastIndex(event => isRecord(event.rawPayload) && event.rawPayload.type === 'turn/start');
      if (start < 0) throw new Error("无法确认被引用回复所在的问答轮次");
    }
    const first = this.entries(events.slice(start))[0];
    if (!first) throw new Error("被引用轮次没有可读取的内容");
    return first.eventId;
  },
  cutoff(source, projection, anchorId) {
    const p = record(projection);
    if (!Array.isArray(p.events)) throw new Error("来源会话没有已登记的原生历史");
    const committedRevision = v3ProjectedNativeRevision({events:source}, projection);
    const events = p.events.map(e => record(e));
    const matches = events.filter(e => {
      if (e.type !== "assistant/message" || e.surfaceOp !== "append" || !isRecord(e.data)) return false;
      const message = record(e.data.message);
      return message.id === anchorId || `14:assistant-step${e.data.turn}:${e.data.step}` === anchorId;
    });
    if (matches.length !== 1) throw new Error("被引用回复尚未完整结束，或来源身份已变化");
    const selected = matches[0]!, data = record(selected.data);
    const ended = events.some(e => e.type === "step/end" && isRecord(e.data)
      && e.data.turn === data.turn && e.data.step === data.step && Number(e.seq) > Number(selected.seq));
    if (!ended) throw new Error("请等待被引用回复完整结束后重试");
    const selectedSeq = Number(selected.seq);
    if (selectedSeq >= committedRevision) throw new Error("被引用回复尚未完整提交到 Maintenance，请稍后重试");
    const ledger = isRecord(p.conversionLedger) ? p.conversionLedger : undefined;
    const canonicalCount = Number(ledger?.canonicalEventCount ?? 0);
    // A receipt must attest the exact canonical prefix, not a similarly titled session.
    if (ledger && ledger.canonicalDigest !== digest(source.slice(0, canonicalCount).map(e => ({ id:e.id,contentDigest:e.contentDigest,source:e.source,rawPayload:e.rawPayload }))))
      throw new Error("来源版本与原生转换回执不一致");
    const mapping = Array.isArray(ledger?.canonicalMapping) ? ledger.canonicalMapping.map(e => record(e)) : undefined;
    const seqMap = Array.isArray(ledger?.seqMap) ? ledger.seqMap : undefined;
    let cut: CanonicalEventV1 | undefined;
    for (let i = 0; i < source.length; i++) {
      const event = source[i]!;
      let positions: number[];
      if (event.extensions.nativeFormatVersion === 3 && isRecord(event.rawPayload)) positions = [Number(event.rawPayload.seq)];
      else if (mapping) {
        const row = mapping.find(m => m.canonicalEventId === event.id);
        positions = row ? [Number(row.archiveSeq)] : [];
      } else if (seqMap && isRecord(event.rawPayload)) {
        const mapped = seqMap[Number(event.rawPayload.seq)];
        positions = Array.isArray(mapped) ? mapped.map(Number) : [];
      } else positions = [];
      if (positions.some(n => Number.isSafeInteger(n) && n <= selectedSeq)) cut = event;
    }
    if (!cut) throw new Error("无法将被引用回复定位到会话真源");
    return { eventId: cut.id, digest: cut.contentDigest };
  },
  entries(events) {
    return events.filter(e => canonicalEventProjectionPolicy(e.kind).modelExposure === "model-visible"
      && e.kind !== "system-message").flatMap(event => {
      const raw = isRecord(event.rawPayload) ? event.rawPayload : undefined;
      if (["runtime-context","skill-catalog","plugin-context"].includes(readDshReaderPresentation(event).kind)) return [];
      // Model compaction replacements are not chronological transcript material.
      if (raw?.surfaceOp && raw.surfaceOp !== "append") return [];
      const c = isRecord(event.content) ? event.content : undefined;
      const message = c && isRecord(c.message) ? c.message : c;
      const content: JsonValue = message?.content ?? event.content;
      return [{ eventId: event.id, role: event.role, text: referenceText(content) }];
    });
  },
};
