import type { CanonicalEventV1, JsonValue } from "@linmu/dsh-session-contracts";
import { Badge } from "@linmu/dsh-session-ui";
import { SafeMarkdown } from "./safe-markdown.js";

export interface CanonicalEventPresentation {
  readonly heldOut: boolean;
  readonly text: string;
}

function stableText(content: JsonValue): string {
  return typeof content === "string" ? content : JSON.stringify(content, null, 2);
}

export function canonicalEventPresentation(event: CanonicalEventV1): CanonicalEventPresentation {
  const heldOut = event.kind === "opaque-unknown";
  return {
    heldOut,
    text: heldOut ? "此事件类型未被当前适配器解释，原始数据已留置且不会执行。" : stableText(event.content),
  };
}

export function CanonicalEventView(props: { readonly event: CanonicalEventV1 }) {
  const presentation = canonicalEventPresentation(props.event);
  return <article className="canonical-event" data-testid={`canonical-event-${props.event.id}`} data-held-out={presentation.heldOut}>
    <header>
      <Badge>{props.event.role}</Badge>
      <strong>{props.event.kind}</strong>
      <code>#{props.event.sequence}</code>
      <span>{props.event.source.platform} / {props.event.source.instanceId}</span>
    </header>
    {presentation.heldOut
      ? <div className="canonical-event-held-out"><p>{presentation.text}</p><a href="#diagnostics" aria-label={`查看事件 ${props.event.id} 的诊断`}>查看诊断</a></div>
      : typeof props.event.content === "string" && !["tool-call", "tool-result", "attachment", "system-metadata"].includes(props.event.kind)
        ? <SafeMarkdown>{presentation.text}</SafeMarkdown>
        : <pre className="canonical-event-json"><code>{presentation.text}</code></pre>}
  </article>;
}
