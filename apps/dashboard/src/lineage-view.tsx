import type { CanonicalLineageRelation } from "@linmu/dsh-session-contracts";
import { Badge, EmptyState } from "@linmu/dsh-session-ui";

import { canonicalOriginLabel } from "./canonical-labels.js";

function RelationButton(props: { readonly relation: CanonicalLineageRelation; readonly direction: "source" | "derived"; readonly onOpen: (id: string) => void }) {
  const { session, derivation } = props.relation;
  return <button
    type="button"
    className="lineage-relation"
    data-testid={`lineage-${props.direction}-${session.id}`}
    onClick={() => props.onOpen(session.id)}
    aria-label={`打开${props.direction === "source" ? "来源" : "派生"}会话 ${session.title}`}
  >
    <span><strong>{session.title || "未命名会话"}</strong><code>{session.id}</code></span>
    <span><Badge>{canonicalOriginLabel(session.originKind)}</Badge><small>基线 {derivation.baseVersionId}</small></span>
  </button>;
}

export function LineageView(props: {
  readonly parent: CanonicalLineageRelation | null;
  readonly children: readonly CanonicalLineageRelation[];
  readonly onOpenSession: (id: string) => void;
}) {
  if (props.parent === null && props.children.length === 0) return <EmptyState title="没有派生关系" description="这个会话目前是独立主线。" />;
  return <div className="lineage-view">
    <section><h3>来源会话</h3>{props.parent === null ? <p className="muted">这是谱系根节点。</p> : <RelationButton relation={props.parent} direction="source" onOpen={props.onOpenSession} />}</section>
    <section><h3>派生会话</h3>{props.children.length === 0 ? <p className="muted">尚无派生会话。</p> : props.children.map((relation) => <RelationButton key={relation.session.id} relation={relation} direction="derived" onOpen={props.onOpenSession} />)}</section>
  </div>;
}
