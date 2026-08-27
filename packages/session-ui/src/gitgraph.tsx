import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";

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
export const GITGRAPH_ROW_HEIGHT = 52;
const LANE_WIDTH = 24;

export interface GitGraphWindow {
  readonly start: number;
  readonly end: number;
}

export function gitGraphWindow(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = 4,
): GitGraphWindow {
  const visibleStart = Math.floor(Math.max(0, scrollTop) / GITGRAPH_ROW_HEIGHT);
  const visibleEnd = Math.ceil((Math.max(0, scrollTop) + Math.max(GITGRAPH_ROW_HEIGHT, viewportHeight)) / GITGRAPH_ROW_HEIGHT);
  return {
    start: Math.max(0, visibleStart - overscan),
    end: Math.min(rowCount, visibleEnd + overscan),
  };
}

export type GitGraphNavigationKey = "ArrowUp" | "ArrowDown" | "Home" | "End";

export function gitGraphKeyboardTarget(
  rows: readonly GitGraphRow[],
  selectedId: string | undefined,
  key: GitGraphNavigationKey,
): GitGraphRow | undefined {
  if (rows.length === 0) return undefined;
  const current = Math.max(0, rows.findIndex((row) => row.node.id === selectedId));
  const index = key === "Home" ? 0
    : key === "End" ? rows.length - 1
      : key === "ArrowUp" ? Math.max(0, current - 1)
        : Math.min(rows.length - 1, current + 1);
  return rows[index];
}

export function GitGraphCanvas(props: {
  readonly nodes: readonly GitGraphNode[];
  readonly selectedId?: string;
  readonly refs?: Readonly<Record<string, string>>;
  readonly onSelect: (id: string) => void;
  /** Deterministic initial viewport used by SSR and tests; ResizeObserver replaces it in the browser. */
  readonly viewportHeight?: number;
}) {
  const layout = useMemo(() => layoutGitGraph(props.nodes), [props.nodes]);
  const viewport = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(props.viewportHeight ?? 520);
  const [pendingFocusId, setPendingFocusId] = useState<string>();
  useEffect(() => {
    const element = viewport.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const update = () => setViewportHeight(Math.max(GITGRAPH_ROW_HEIGHT, element.clientHeight));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const window = gitGraphWindow(layout.rows.length, scrollTop, viewportHeight);
  const visibleRows = layout.rows.slice(window.start, window.end);
  const visibleEdges = layout.edges.filter((edge) =>
    (edge.fromRow >= window.start && edge.fromRow < window.end) ||
    (edge.toRow >= window.start && edge.toRow < window.end),
  );
  useEffect(() => {
    if (pendingFocusId === undefined) return;
    const button = buttons.current.get(pendingFocusId);
    if (button !== undefined) {
      button.focus();
      setPendingFocusId(undefined);
    }
  }, [pendingFocusId, window.start, window.end]);
  const refsByVersion = new Map<string, string[]>();
  for (const [name, versionId] of Object.entries(props.refs ?? {})) {
    refsByVersion.set(versionId, [...(refsByVersion.get(versionId) ?? []), name]);
  }
  const graphWidth = 28 + layout.laneCount * LANE_WIDTH;
  const height = Math.max(72, layout.rows.length * GITGRAPH_ROW_HEIGHT + 18);
  const point = (row: number, lane: number) => ({ x: 18 + lane * LANE_WIDTH, y: 20 + row * GITGRAPH_ROW_HEIGHT });
  const selectAndFocus = (row: GitGraphRow) => {
    props.onSelect(row.node.id);
    const element = viewport.current;
    if (element !== null) {
      const top = row.row * GITGRAPH_ROW_HEIGHT;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + GITGRAPH_ROW_HEIGHT > element.scrollTop + element.clientHeight) {
        element.scrollTop = top + GITGRAPH_ROW_HEIGHT - element.clientHeight;
      }
      setScrollTop(element.scrollTop);
    }
    setPendingFocusId(row.node.id);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const target = gitGraphKeyboardTarget(layout.rows, props.selectedId, event.key as GitGraphNavigationKey);
    if (target !== undefined) selectAndFocus(target);
  };
  return <div
    className="dsm-gitgraph"
    role="tree"
    aria-label="会话版本树"
    ref={viewport}
    onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    onKeyDown={onKeyDown}
    style={{ "--dsm-graph-width": `${graphWidth}px` } as CSSProperties}
  >
    <div className="dsm-gitgraph-virtual-space" style={{ height }}>
    <svg className="dsm-gitgraph-lines" width={graphWidth} height={height} aria-hidden="true">
      {visibleEdges.map((edge, index) => {
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
      {visibleRows.map((row) => {
        const p = point(row.row, row.lane);
        return <circle key={row.node.id} cx={p.x} cy={p.y} r={props.selectedId === row.node.id ? 6 : 4.5} fill={COLORS[row.lane % COLORS.length]} stroke="#fff" strokeWidth="2" />;
      })}
    </svg>
    <div className="dsm-gitgraph-rows">
      {visibleRows.map((row) => <button
        type="button"
        className="dsm-gitgraph-row"
        role="treeitem"
        aria-selected={props.selectedId === row.node.id}
        data-selected={props.selectedId === row.node.id}
        key={row.node.id}
        tabIndex={props.selectedId === row.node.id || (props.selectedId === undefined && row.row === 0) ? 0 : -1}
        ref={(element) => { if (element === null) buttons.current.delete(row.node.id); else buttons.current.set(row.node.id, element); }}
        style={{ transform: `translateY(${row.row * GITGRAPH_ROW_HEIGHT}px)` }}
        onClick={() => selectAndFocus(row)}
      >
        <strong>{row.node.label ?? row.node.id.slice(0, 12)}</strong>
        <span>{new Date(row.node.observedAt).toLocaleString()}</span>
        {(refsByVersion.get(row.node.id) ?? []).map((name) => <small key={name}>{name}</small>)}
      </button>)}
    </div>
    </div>
  </div>;
}
