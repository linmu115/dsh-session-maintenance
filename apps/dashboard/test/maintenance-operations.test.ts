import { describe, expect, it } from "vitest";

import { canonicalSessionPatchFromForm } from "../src/operations-pages.js";

describe("Maintenance canonical operations model", () => {
  it("normalizes workspace, title, tags, pin and archive without native identifiers", () => {
    expect(canonicalSessionPatchFromForm({
      title: "  稳定标题  ",
      tags: "研究,  引用,研究",
      workspaceId: "workspace-logical",
      pinned: true,
      archived: false,
    })).toEqual({
      title: "稳定标题",
      tags: ["研究", "引用", "研究"],
      workspaceId: "workspace-logical",
      pinned: true,
      archived: false,
    });
  });

  it("uses null for the unclassified workspace", () => {
    expect(canonicalSessionPatchFromForm({ title: "会话", tags: "", workspaceId: "", pinned: false, archived: true })).toMatchObject({
      workspaceId: null,
      tags: [],
      archived: true,
    });
  });
});
