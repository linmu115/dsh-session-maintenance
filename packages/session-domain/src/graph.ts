import type { VersionNode } from "@linmu/dsh-session-contracts";

export type HeadClassification =
  | { readonly kind: "equal" }
  | { readonly kind: "source-ahead" }
  | { readonly kind: "target-ahead" }
  | { readonly kind: "diverged"; readonly mergeBase: string }
  | { readonly kind: "unrelated" };

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class VersionGraph {
  readonly nodes: ReadonlyMap<string, VersionNode>;

  constructor(nodes: readonly VersionNode[]) {
    const byId = new Map<string, VersionNode>();
    for (const node of nodes) {
      if (!node.id) {
        throw new TypeError("Version node ID must not be empty");
      }
      if (node.parents.length > 2) {
        throw new TypeError(`Version node ${node.id} may have at most two parents`);
      }
      if (new Set(node.parents).size !== node.parents.length) {
        throw new TypeError(`Version node ${node.id} has a duplicate parent`);
      }
      if (byId.has(node.id)) {
        throw new TypeError(`Duplicate version node ID: ${node.id}`);
      }
      byId.set(node.id, { id: node.id, parents: [...node.parents] });
    }

    for (const node of byId.values()) {
      for (const parent of node.parents) {
        if (!byId.has(parent)) {
          throw new TypeError(`Version node ${node.id} has missing parent: ${parent}`);
        }
      }
    }

    const state = new Map<string, "visiting" | "visited">();
    const visit = (id: string): void => {
      const current = state.get(id);
      if (current === "visiting") {
        throw new TypeError(`Version graph contains a cycle at ${id}`);
      }
      if (current === "visited") {
        return;
      }

      state.set(id, "visiting");
      const node = byId.get(id);
      if (node === undefined) {
        throw new TypeError(`Unknown version node: ${id}`);
      }
      for (const parent of node.parents) {
        visit(parent);
      }
      state.set(id, "visited");
    };

    for (const id of byId.keys()) {
      visit(id);
    }

    this.nodes = byId;
  }

  isAncestor(ancestorId: string, descendantId: string): boolean {
    this.requireNode(ancestorId);
    this.requireNode(descendantId);
    return this.ancestorDistances(descendantId).has(ancestorId);
  }

  findMergeBase(leftId: string, rightId: string): string | undefined {
    const leftDistances = this.ancestorDistances(leftId);
    const rightDistances = this.ancestorDistances(rightId);
    let best: { readonly id: string; readonly distance: number } | undefined;

    for (const [id, leftDistance] of leftDistances) {
      const rightDistance = rightDistances.get(id);
      if (rightDistance === undefined) {
        continue;
      }

      const distance = leftDistance + rightDistance;
      if (
        best === undefined ||
        distance < best.distance ||
        (distance === best.distance && lexicalCompare(id, best.id) < 0)
      ) {
        best = { id, distance };
      }
    }

    return best?.id;
  }

  private requireNode(id: string): VersionNode {
    const node = this.nodes.get(id);
    if (node === undefined) {
      throw new TypeError(`Unknown version node: ${id}`);
    }
    return node;
  }

  private ancestorDistances(startId: string): ReadonlyMap<string, number> {
    this.requireNode(startId);
    const distances = new Map<string, number>([[startId, 0]]);
    const queue: string[] = [startId];

    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index];
      if (id === undefined) {
        continue;
      }
      const distance = distances.get(id);
      const node = this.requireNode(id);
      if (distance === undefined) {
        continue;
      }

      for (const parent of node.parents) {
        const candidate = distance + 1;
        const previous = distances.get(parent);
        if (previous === undefined || candidate < previous) {
          distances.set(parent, candidate);
          queue.push(parent);
        }
      }
    }

    return distances;
  }
}

export function classifyHeads(
  graph: VersionGraph,
  sourceId: string,
  targetId: string,
): HeadClassification {
  if (sourceId === targetId) {
    graph.isAncestor(sourceId, targetId);
    return { kind: "equal" };
  }
  if (graph.isAncestor(sourceId, targetId)) {
    return { kind: "target-ahead" };
  }
  if (graph.isAncestor(targetId, sourceId)) {
    return { kind: "source-ahead" };
  }

  const mergeBase = graph.findMergeBase(sourceId, targetId);
  return mergeBase === undefined ? { kind: "unrelated" } : { kind: "diverged", mergeBase };
}
