import type { DatabaseSync } from "node:sqlite";
import type { GraphDocument, ExtensionList, ExtensionPage } from "@linmu/dsh-session-contracts";

const generated = /^(?:dsh-maintenance[-:]\S+|(?:logical-session|session|sess|ls)[-:][a-z0-9-]{12,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;
function readable(value: string | undefined, id: string) {
  const title = value?.trim();
  return title && title !== id && !generated.test(title) ? title.slice(0, 500) : undefined;
}
function titles(db: DatabaseSync, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  return new Map((db.prepare(`SELECT id,display_title title FROM logical_sessions WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as { id: string; title: string }[]).map(row => [row.id, row.title]));
}
/** Names are current metadata; reading a name never rewrites a graph or its fixed sources. */
export function presentGraphTitles(db: DatabaseSync, doc: GraphDocument): GraphDocument {
  const ids = [...new Set([...(doc.graph.ownerSessionId ? [doc.graph.ownerSessionId] : []),
    ...doc.graph.nodes.flatMap(node => node.data.kind === "session" && node.data.logicalSessionId ? [node.data.logicalSessionId] : [])])];
  const current = titles(db, ids);
  const name = (id: string, fallback: string) => readable(current.get(id), id) ?? readable(fallback, id) ?? "未命名会话";
  return { ...doc, title: doc.graph.ownerSessionId ? name(doc.graph.ownerSessionId, doc.title) : doc.title,
    graph: { ...doc.graph, nodes: doc.graph.nodes.map(node => node.data.kind === "session" && node.data.logicalSessionId
      ? { ...node, data: { ...node.data, label: name(node.data.logicalSessionId, node.data.label) } } : node) } };
}
export function presentGraphList(db: DatabaseSync, query: ExtensionList, page: ExtensionPage): ExtensionPage {
  if (query.namespace !== "thoughtdag" || !page.items.length) return page;
  const rows = db.prepare(`SELECT o.object_id objectId,json_extract(o.content_json,'$.body.ownerSessionId') owner,s.display_title title
    FROM extension_objects o LEFT JOIN logical_sessions s ON s.id=json_extract(o.content_json,'$.body.ownerSessionId')
    WHERE o.instance_id=? AND o.profile_id=? AND o.namespace='thoughtdag'
    AND json_extract(o.content_json,'$.body.managedSchema')=2 AND json_type(o.content_json,'$.body.nodes')='array'
    AND o.object_id IN (${page.items.map(() => "?").join(",")})`)
    .all(query.instanceId, query.profileId, ...page.items.map(item => item.objectId)) as { objectId: string; owner: string | null; title: string | null }[];
  const names = new Map(rows.filter(row => row.owner).map(row => [row.objectId, { id: row.owner!, title: row.title ?? undefined }]));
  return { ...page, items: page.items.map(item => { const row = names.get(item.objectId); return row
    ? { ...item, title: readable(row.title, row.id) ?? readable(item.title, row.id) ?? "未命名会话" } : item; }) };
}
