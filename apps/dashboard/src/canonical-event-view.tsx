import type { CanonicalDashboardEvent, JsonValue } from "@linmu/dsh-session-contracts";
import { Badge } from "@linmu/dsh-session-ui";
import { SafeMarkdown } from "./safe-markdown.js";

export interface CanonicalEventPresentation { readonly heldOut: boolean; readonly text: string }
function jsonRecord(content: JsonValue): content is Readonly<Record<string, JsonValue>> {
  return typeof content === "object" && content !== null && !Array.isArray(content);
}
export function canonicalEventPresentation(event: CanonicalDashboardEvent): CanonicalEventPresentation {
  const heldOut = event.kind === "opaque-unknown" || event.kind === "other";
  const other = event.kind === "other" && jsonRecord(event.content) ? event.content : undefined;
  return {
    heldOut,
    text: heldOut ? typeof other?.summary === "string" ? other.summary : "此事件类型未被当前适配器解释，原始数据已留置且不会执行。"
      : event.readableText ?? (typeof event.content === "string" ? event.content : JSON.stringify(event.content, null, 2)),
  };
}
const labels: Readonly<Record<string, string>> = {
  "tool-call": "工具调用", "tool-result": "工具结果", reasoning: "推理记录", "system-message": "系统记录",
  attachment: "附件信息", "system-metadata": "系统信息", annotation: "批注", sticker: "贴纸",
  "obsidian-reference": "笔记引用", other: "其他记录", "opaque-unknown": "未识别记录",
};
export function CanonicalEventView({ event }: { readonly event: CanonicalDashboardEvent }) {
  const presentation = canonicalEventPresentation(event);
  const message = event.kind === "user-message" || event.kind === "assistant-message";
  const text = event.readableText ?? undefined;
  const metadata = <details className="event-metadata"><summary>原始记录与来源</summary><p>{event.source.platform} · {event.source.instanceId} · #{event.sequence}</p><code>{event.id}</code><pre className="canonical-event-json"><code>{JSON.stringify({ content: event.content, rawPayload: event.rawPayload }, null, 2)}</code></pre></details>;
  return <article className="canonical-event" data-testid={`canonical-event-${event.id}`} data-held-out={presentation.heldOut} data-role={event.role}>
    {message ? <><header><Badge>{event.role === "user" ? "你" : "助手"}</Badge></header>{text === undefined ? <p className="muted">{event.readableText === undefined ? "当前引擎未提供可读正文，可展开原始记录查看。" : "暂未解析出可读正文，可展开原始记录查看。"}</p> : <SafeMarkdown>{text}</SafeMarkdown>}{metadata}</> : <details className="event-supporting"><summary>{labels[event.kind] ?? "补充记录"}</summary>{presentation.heldOut ? <p>{presentation.text}</p> : text === undefined ? <pre className="canonical-event-json"><code>{presentation.text}</code></pre> : <SafeMarkdown>{text}</SafeMarkdown>}{metadata}</details>}
  </article>;
}
