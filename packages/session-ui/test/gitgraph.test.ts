import { describe, expect, it } from "vitest";

import { layoutGitGraph, type GitGraphNode } from "../src/gitgraph.js";

const node = (id: string, parents: readonly string[], observedAt: string): GitGraphNode => ({ id, parents, observedAt });

describe("layoutGitGraph", () => {
  it("lays out linear, divergent and two-parent histories deterministically", () => {
    const nodes = [
      node("merge", ["left", "right"], "2026-08-27T00:00:04.000Z"),
      node("right", ["base"], "2026-08-27T00:00:03.000Z"),
      node("left", ["base"], "2026-08-27T00:00:02.000Z"),
      node("base", ["root"], "2026-08-27T00:00:01.000Z"),
      node("root", [], "2026-08-27T00:00:00.000Z"),
    ];
    const first = layoutGitGraph(nodes);
    const shuffled = layoutGitGraph([nodes[3]!, nodes[1]!, nodes[4]!, nodes[0]!, nodes[2]!]);
    expect(first).toEqual(shuffled);
    expect(first.rows.map((row) => row.node.id)).toEqual(["merge", "right", "left", "base", "root"]);
    expect(first.edges).toHaveLength(5);
    expect(first.laneCount).toBeGreaterThanOrEqual(2);
  });
});
