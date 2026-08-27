import type { CSSProperties } from "react";

export interface GitGraphNode {
  readonly id: string;
  readonly parents: readonly string[];
  readonly observedAt: string;
  readonly label?: string;
}

export interface GitGraphRow {
  readonly node: GitGraphNode;
  readonly row: number;
  readonly lane: number;
}

export interface GitGraphEdge {
  readonly fromRow: number;
  readonly fromLane: number;
  readonly toRow: number;
  readonly toLane: number;
}

export interface GitGraphLayout {
  readonly rows: readonly GitGraphRow[];
  readonly edges: readonly GitGraphEdge[];
  readonly laneCount: number;
}

function orderNodes(nodes: readonly GitGraphNode[]): readonly GitGraphNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const remainingChildren = new Map(nodes.map((node) => [node.id, 0]));
  for (const node of nodes) {
    for (const parent of node.parents) {
      if (byId.has(parent)) remainingChildren.set(parent, (remainingChildren.get(parent) ?? 0) + 1);
    }
  }
  const compare = (left: GitGraphNode, right: GitGraphNode) =>
    right.observedAt.localeCompare(left.observedAt) || left.id.localeCompare(right.id);
  const ready = nodes.filter((node) => remainingChildren.get(node.id) === 0).sort(compare);
  const ordered: GitGraphNode[] = [];
  while (ready.length > 0) {
    const node = ready.shift()!;
    ordered.push(node);
    for (const parentId of node.parents) {
      const parent = byId.get(parentId);
      if (parent === undefined) continue;
      const next = (remainingChildren.get(parentId) ?? 1) - 1;
      remainingChildren.set(parentId, next);
      if (next === 0) {
        ready.push(parent);
        ready.sort(compare);
      }
    }
  }
  const seen = new Set(ordered.map((node) => node.id));
  return [...ordered, ...nodes.filter((node) => !seen.has(node.id)).sort(compare)];
}

export function layoutGitGraph(nodes: readonly GitGraphNode[]): GitGraphLayout {
  const ordered = orderNodes(nodes);
  const active: Array<string | undefined> = [];
  const rows: GitGraphRow[] = [];
  for (const [row, node] of ordered.entries()) {
    let lane = active.indexOf(node.id);
    if (lane < 0) {
      lane = active.findIndex((value) => value === undefined);
      if (lane < 0) lane = active.length;
    }
    active[lane] = undefined;
    for (const [index, parent] of node.parents.entries()) {
      if (active.includes(parent)) continue;
      if (index === 0) active[lane] = parent;
      else active.splice(lane + index, 0, parent);
    }
    rows.push({ node, row, lane });
  }
  const byId = new Map(rows.map((row) => [row.node.id, row]));
  const edges = rows.flatMap((row) => row.node.parents.flatMap((parentId) => {
    const parent = byId.get(parentId);
    return parent === undefined ? [] : [{ fromRow: row.row, fromLane: row.lane, toRow: parent.row, toLane: parent.lane }];
  }));
  return { rows, edges, laneCount: Math.max(1, ...rows.map((row) => row.lane + 1)) };
}

const COLORS = ["#16875f", "#376fbb", "#a86a00", "#9255b5", "#bd3a3a", "#1c8392"];
const ROW_HEIGHT = 52;
const LANE_WIDTH = 24;

export function GitGraphCanvas(props: {
  readonly nodes: readonly GitGraphNode[];
  readonly selectedId?: string;
  readonly refs?: Readonly<Record<string, string>>;
  readonly onSelect: (id: string) => void;
}) {
  const layout = layoutGitGraph(props.nodes);
  const refsByVersion = new Map<string, string[]>();
  for (const [name, versionId] of Object.entries(props.refs ?? {})) {
    refsByVersion.set(versionId, [...(refsByVersion.get(versionId) ?? []), name]);
  }
  const graphWidth = 28 + layout.laneCount * LANE_WIDTH;
  const height = Math.max(72, layout.rows.length * ROW_HEIGHT + 18);
  const point = (row: number, lane: number) => ({ x: 18 + lane * LANE_WIDTH, y: 20 + row * ROW_HEIGHT });
  return <div className="dsm-gitgraph" style={{ "--dsm-graph-width": `${graphWidth}px` } as CSSProperties}>
    <svg className="dsm-gitgraph-lines" width={graphWidth} height={height} aria-hidden="true">
      {layout.edges.map((edge, index) => {
        const from = point(edge.fromRow, edge.fromLane);
        const to = point(edge.toRow, edge.toLane);
        const middle = from.y + (to.y - from.y) / 2;
        return <path
          key={`${edge.fromRow}-${edge.toRow}-${index}`}
          d={`M ${from.x} ${from.y} C ${from.x} ${middle}, ${to.x} ${middle}, ${to.x} ${to.y}`}
          fill="none"
          stroke={COLORS[edge.fromLane % COLORS.length]}
          strokeWidth="2"
        />;
      })}
      {layout.rows.map((row) => {
        const p = point(row.row, row.lane);
        return <circle key={row.node.id} cx={p.x} cy={p.y} r={props.selectedId === row.node.id ? 6 : 4.5} fill={COLORS[row.lane % COLORS.length]} stroke="#fff" strokeWidth="2" />;
      })}
    </svg>
    <div className="dsm-gitgraph-rows" style={{ minHeight: height }}>
      {layout.rows.map((row) => <button
        type="button"
        className="dsm-gitgraph-row"
        data-selected={props.selectedId === row.node.id}
        key={row.node.id}
        onClick={() => props.onSelect(row.node.id)}
      >
        <strong>{row.node.label ?? row.node.id.slice(0, 12)}</strong>
        <span>{new Date(row.node.observedAt).toLocaleString()}</span>
        {(refsByVersion.get(row.node.id) ?? []).map((name) => <small key={name}>{name}</small>)}
      </button>)}
    </div>
  </div>;
}
