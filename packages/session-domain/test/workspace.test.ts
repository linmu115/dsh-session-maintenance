import { describe, expect, it } from "vitest";

import { workspaceIdFromPath, workspaceLabelFromPath } from "../src/workspace.js";

describe("workspace path identity", () => {
  it("unifies equivalent Windows paths across DSH and Codex while preserving a readable label", () => {
    expect(workspaceIdFromPath("D:\\AI\\DeepSeek\\")).toBe(workspaceIdFromPath("d:/ai/deepseek"));
    expect(workspaceLabelFromPath("D:\\AI\\DeepSeek\\")).toBe("DeepSeek");
  });

  it("keeps distinct directory paths separate even when their final names match", () => {
    expect(workspaceIdFromPath("D:\\AI\\DeepSeek")).not.toBe(workspaceIdFromPath("C:\\Projects\\DeepSeek"));
  });
});
