import type { SessionFormatEvent, SessionFormatJsonObject } from "@deepseek-ai/dsh-session-format";
import { digest, isRecord, record } from "./common.js";
const PREFIX = "dsh-maintenance-legacy-annotation:";
const FIELDS = ["kind", "schemaVersion", "setId", "targetUserMessageId", "count", "digest"];

/** These are Harness message slots; arbitrary tool arguments, text and title-source metadata are never traversed. */
function mapMessages(event: SessionFormatEvent, map: (message: SessionFormatJsonObject, slot: string) => SessionFormatJsonObject): SessionFormatEvent {
 const data = record(event.data);
 if (event.type === "user/message") return { ...event, data: map(data, "data") };
 if ((event.type === "assistant/message" || event.type === "tool/result") && Object.hasOwn(data, "message")) return { ...event, data: { ...data, message: map(record(data.message), "data.message") } };
 if (event.type === "agent/inbox/spliced" || event.type === "session/title-llm-request") {
  const key = event.type === "agent/inbox/spliced" ? "inserted" : "messages";
  if (!Array.isArray(data[key])) throw new TypeError("Legacy message collection is missing");
  return { ...event, data: { ...data, [key]: data[key].map((m, i) => map(record(m), `data.${key}[${i}]`)) } };
 }
 return event;
}

/** RC2's historical whitelist predates Annotation Core. Its runtime V3 vocabulary accepts the original source.
 * Admit only the proven schema-v1 user context envelope through official structural migration, then restore it.
 * Producer: Core host/commit-journal.ts. Consumers: client/conversation-projection.tsx, host/reference-tools.ts.
 */
export function admitAnnotationSources(events: readonly SessionFormatEvent[]) {
 const sources = new Map<string, SessionFormatJsonObject>();
 const counts = new Map<string, number>();
 const ledger: { eventSeq: number; slot: string; messageId: string; source: SessionFormatJsonObject }[] = [];
 const admitted = events.map(event => mapMessages(event, (message, slot) => {
  const source = record(message.source, "Legacy message source");
  if (source.kind === "plugin" && typeof source.plugin === "string" && source.plugin.startsWith(PREFIX)) throw new TypeError("Reserved legacy admission source collision");
  if (source.kind !== "dsh-annotation") return message;
  if (message.role !== "user" || typeof message.id !== "string" || message.id.length === 0
   || Object.keys(source).length !== FIELDS.length || Object.keys(source).some(key => !FIELDS.includes(key))
   || source.schemaVersion !== 1 || typeof source.setId !== "string" || !source.setId
   || typeof source.targetUserMessageId !== "string" || !source.targetUserMessageId
   || !Number.isSafeInteger(source.count) || (source.count as number) < 1
   || typeof source.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(source.digest)) throw new TypeError("Unaudited legacy annotation source shape");
  const token = PREFIX + digest({ id: message.id, source });
  sources.set(token, source); counts.set(token, (counts.get(token) ?? 0) + 1);
  ledger.push({ eventSeq: event.seq, slot, messageId: message.id, source });
  return { ...message, source: { kind: "plugin", plugin: token } };
 }));
 return { events: admitted, ledger, restore(target: readonly SessionFormatEvent[]) {
  const restored = new Map<string, number>();
  const result = target.map(event => mapMessages(event, message => {
   const source = message.source;
   if (!isRecord(source) || source.kind !== "plugin" || typeof source.plugin !== "string" || !source.plugin.startsWith(PREFIX)) return message;
   const original = sources.get(source.plugin);
   if (original === undefined || source.plugin !== PREFIX + digest({ id: message.id, source: original })) throw new TypeError("Legacy annotation attribution changed during migration");
   restored.set(source.plugin, (restored.get(source.plugin) ?? 0) + 1);
   return { ...message, source: original };
  }));
  for (const [token, count] of counts) if (restored.get(token) !== count) throw new TypeError("Legacy annotation message was lost during migration");
  return result;
 } };
}
