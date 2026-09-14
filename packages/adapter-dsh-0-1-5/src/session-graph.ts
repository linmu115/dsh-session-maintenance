import type { SessionGraphAdapter } from "@linmu/dsh-session-contracts";
import { isRecord, record } from "./common.js";
import { v3SessionContext } from "./session-context.js";

/** Reuses the fixed-cutoff attestation; incomplete replies never become graph sources. */
export const v3SessionGraph: SessionGraphAdapter = {
  completedTurn(source, projection, beforeEventId, anchorId) {
    const p = record(projection);
    if (!Array.isArray(p.events)) throw new Error("会话没有可验证的原生历史");
    const before = beforeEventId === undefined ? source.length : source.findIndex(e => e.id === beforeEventId);
    if (before < 0) throw new Error("预览完成位置不可用，请刷新");
    const events = p.events.map(e => record(e));
    for (const event of events.toReversed()) {
      if (event.type !== "assistant/message" || event.surfaceOp !== "append" || !isRecord(event.data)) continue;
      const data = record(event.data), message = record(data.message);
      if (anchorId !== undefined && message.id !== anchorId) continue;
      if (typeof message.id !== "string" || !events.some(e => e.type === "step/end" && isRecord(e.data)
        && e.data.turn === data.turn && e.data.step === data.step && Number(e.seq) > Number(event.seq))) continue;
      const cutoff = v3SessionContext.cutoff(source, projection, message.id);
      const index = source.findIndex(e => e.id === cutoff.eventId);
      if (index >= before) continue;
      const fixed = source.slice(0, index + 1);
      const start = v3SessionContext.selectedTurnStart(fixed), reply = v3SessionContext.selectedReply(fixed);
      const entries = v3SessionContext.entries(fixed);
      const first = entries.findIndex(e => e.eventId === start);
      const selected = entries.filter((e, i) => i >= first && (e.role === "user" || e.eventId === reply));
      return { cutoffEventId: cutoff.eventId, anchorId: message.id, messageId: message.id,
        entries: selected, selectedText: selected.find(e => e.eventId === reply)?.text ?? "" };
    }
    return undefined;
  },
};
