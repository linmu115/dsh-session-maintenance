import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { GitGraphCanvas, gitGraphKeyboardTarget, gitGraphWindow, layoutGitGraph, type GitGraphNode } from "../src/gitgraph.js";

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

  it("renders only the virtual viewport for a 1000-node history", () => {
    const nodes = Array.from({ length: 1_000 }, (_value, index) => node(
      `node-${index}`,
      index === 999 ? [] : [`node-${index + 1}`],
      new Date(Date.UTC(2026, 7, 27, 0, 0, 0, 1_000 - index)).toISOString(),
    ));
    const window = gitGraphWindow(nodes.length, 0, 260);
    expect(window.end - window.start).toBeLessThanOrEqual(10);
    const markup = renderToStaticMarkup(createElement(GitGraphCanvas, { nodes, onSelect: vi.fn(), viewportHeight: 260 }));
    expect((markup.match(/role="treeitem"/gu) ?? [])).toHaveLength(window.end - window.start);
    expect((markup.match(/<circle/gu) ?? []).length).toBeLessThanOrEqual(10);
    expect((markup.match(/<path/gu) ?? []).length).toBeLessThanOrEqual(10);
  });

  it("maps ArrowUp/Down/Home/End to selection and focus targets", () => {
    const rows = layoutGitGraph([
      node("three", ["two"], "2026-08-27T00:00:03.000Z"),
      node("two", ["one"], "2026-08-27T00:00:02.000Z"),
      node("one", [], "2026-08-27T00:00:01.000Z"),
    ]).rows;
    expect(gitGraphKeyboardTarget(rows, "two", "ArrowUp")?.node.id).toBe("three");
    expect(gitGraphKeyboardTarget(rows, "two", "ArrowDown")?.node.id).toBe("one");
    expect(gitGraphKeyboardTarget(rows, "two", "Home")?.node.id).toBe("three");
    expect(gitGraphKeyboardTarget(rows, "two", "End")?.node.id).toBe("one");
  });
});
