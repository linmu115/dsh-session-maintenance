import { describe, expect, it } from "vitest";

import { VersionGraph, classifyHeads } from "../src/index.js";

describe("VersionGraph", () => {
  it("classifies equal, fast-forward, divergence and unrelated roots", () => {
    const graph = new VersionGraph([
      { id: "base", parents: [] },
      { id: "codex", parents: ["base"] },
      { id: "dsh", parents: ["base"] },
      { id: "other", parents: [] },
    ]);

    expect(classifyHeads(graph, "base", "base")).toEqual({ kind: "equal" });
    expect(classifyHeads(graph, "base", "codex")).toEqual({ kind: "target-ahead" });
    expect(classifyHeads(graph, "codex", "base")).toEqual({ kind: "source-ahead" });
    expect(classifyHeads(graph, "codex", "dsh")).toEqual({
      kind: "diverged",
      mergeBase: "base",
    });
    expect(classifyHeads(graph, "codex", "other")).toEqual({ kind: "unrelated" });
  });

  it("supports two-parent nodes and deterministic merge-base ties", () => {
    const graph = new VersionGraph([
      { id: "root", parents: [] },
      { id: "a", parents: ["root"] },
      { id: "b", parents: ["root"] },
      { id: "left", parents: ["a", "b"] },
      { id: "right", parents: ["b", "a"] },
      { id: "resolved", parents: ["left", "right"] },
    ]);

    expect(graph.isAncestor("a", "resolved")).toBe(true);
    expect(graph.isAncestor("b", "resolved")).toBe(true);
    expect(graph.findMergeBase("left", "right")).toBe("a");
    expect(classifyHeads(graph, "left", "resolved")).toEqual({ kind: "target-ahead" });
  });

  it("rejects malformed DAGs", () => {
    expect(
      () => new VersionGraph([{ id: "same", parents: [] }, { id: "same", parents: [] }]),
    ).toThrow(/duplicate/iu);
    expect(() => new VersionGraph([{ id: "child", parents: ["missing"] }])).toThrow(
      /missing parent/iu,
    );
    expect(
      () =>
        new VersionGraph([
          { id: "a", parents: ["b"] },
          { id: "b", parents: ["a"] },
        ]),
    ).toThrow(/cycle/iu);
    expect(
      () =>
        new VersionGraph([
          { id: "a", parents: [] },
          { id: "b", parents: [] },
          { id: "c", parents: [] },
          { id: "many", parents: ["a", "b", "c"] },
        ]),
    ).toThrow(/two parents/iu);
  });
});
