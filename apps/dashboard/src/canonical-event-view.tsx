import type { CanonicalDashboardEvent, JsonValue } from "@linmu/dsh-session-contracts";
import { useState } from "react";
import { Badge } from "@linmu/dsh-session-ui";
import { SafeMarkdown } from "./safe-markdown.js";
import { isOpaqueEvent, packOpaqueEvents } from '@linmu/dsh-session-contracts';

export function CanonicalEventList({ events }: { readonly events: readonly CanonicalDashboardEvent[] }) {
  const unknown = events.filter(isOpaqueEvent);
  const bundle = unknown.length ? packOpaqueEvents(unknown) : undefined;
  return <>{events.map(event => isOpaqueEvent(event)
    ? event.id === bundle?.events[0]?.id ? <article key={`opaque-${event.id}`} className="canonical-event" data-held-out="true"><details>
      <summary>未识别数据包（{bundle.events.length} 条）</summary>
      <p className="muted">原始数据及来源已完整保留，当前不展示内部结构。</p>
    </details></article> : null
    : <CanonicalEventView key={event.id} event={event} />)}</>;
}

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
      : event.readableText ?? (typeof event.content === "string" ? event.content : "结构化数据已保存，当前没有可读展示。"),
  };
}
const labels: Readonly<Record<string, string>> = {
  "tool-call": "工具调用", "tool-result": "工具结果", reasoning: "推理记录", "system-message": "系统记录",
  attachment: "附件信息", "system-metadata": "系统信息", annotation: "批注", sticker: "贴纸",
  "obsidian-reference": "笔记引用", other: "其他记录", "opaque-unknown": "未识别记录",
};
export function CanonicalEventView({ event }: { readonly event: CanonicalDashboardEvent }) {
  const [expanded, setExpanded] = useState(false), [metadataOpen, setMetadataOpen] = useState(false);
  if (isOpaqueEvent(event)) return <article className="canonical-event" data-testid={`canonical-event-${event.id}`} data-held-out="true"><details>
    <summary>未识别数据包（1 条）</summary><p className="muted">原始数据及来源已完整保留，当前不展示内部结构。</p>
  </details></article>;
  const presentation = expanded ? canonicalEventPresentation(event) : { heldOut: false, text: "" };
  const message = event.kind === "user-message" || event.kind === "assistant-message";
  const text = event.readableText ?? undefined;
  const metadata = <details className="event-metadata" onToggle={event => setMetadataOpen(event.currentTarget.open)}><summary>原始记录与来源</summary>{metadataOpen ? <><p>{event.source.platform} · {event.source.instanceId} · #{event.sequence}</p><code>{event.id}</code><pre className="canonical-event-json"><code>{JSON.stringify({ content: event.content, rawPayload: event.rawPayload }, null, 2)}</code></pre></> : null}</details>;
  return <article className="canonical-event" data-testid={`canonical-event-${event.id}`} data-held-out={presentation.heldOut} data-role={event.role}>
    {message ? <><header><Badge>{event.role === "user" ? "你" : "助手"}</Badge></header>{text === undefined ? <p className="muted">{event.readableText === undefined ? "当前引擎未提供可读正文，可展开原始记录查看。" : "暂未解析出可读正文，可展开原始记录查看。"}</p> : <SafeMarkdown>{text}</SafeMarkdown>}{metadata}</> : <details className="event-supporting" onToggle={event => setExpanded(event.currentTarget.open)}><summary>{labels[event.kind] ?? "补充记录"}</summary>{expanded ? <>{presentation.heldOut ? <p>{presentation.text}</p> : text === undefined ? <pre className="canonical-event-json"><code>{presentation.text}</code></pre> : <SafeMarkdown>{text}</SafeMarkdown>}{metadata}</> : null}</details>}
  </article>;
}
