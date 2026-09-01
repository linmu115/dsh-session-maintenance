import { describe, expect, it } from "vitest";

import type { CodexThreadRow } from "../src/parser.js";
import {
  CODEX_OUTSIDE_PROJECT_ID,
  CODEX_PENDING_PROJECT_ID,
  normalizeCodexProjectPath,
  resolveCodexProject,
  type CodexProjectCatalog,
} from "../src/projects.js";

const catalog: CodexProjectCatalog = {
  projects: [
    { id: "project-dsh", name: "dsh", roots: ["C:\\work\\dsh", "C:\\shared"] },
    { id: "project-skill", name: "skill管理", roots: ["C:\\work\\skill"] },
    { id: "project-other", name: "Other", roots: ["C:\\shared"] },
  ],
};

function thread(input: Partial<CodexThreadRow> = {}): CodexThreadRow {
  return {
    id: "thread-1",
    rollout_path: "rollout.jsonl",
    title: "Title",
    name: null,
    cwd: "\\\\?\\C:\\work\\skill\\nested",
    created_at: 1,
    updated_at: 2,
    updated_at_ms: 2_000,
    archived: 0,
    project_id: null,
    ...input,
  };
}

describe("Codex project resolution", () => {
  it("uses direct project, override, unique root, pending and outside in order", () => {
    expect(resolveCodexProject(thread({ project_id: "project-dsh" }), catalog).kind)
      .toBe("thread-project-id");
    expect(resolveCodexProject(thread(), catalog, { byThreadId: { "thread-1": "project-dsh" } }).kind)
      .toBe("explicit-override");
    expect(resolveCodexProject(thread(), catalog)).toMatchObject({
      projectId: "project-skill",
      projectName: "skill管理",
      kind: "unique-longest-root",
    });
    expect(resolveCodexProject(thread({ cwd: "C:\\shared\\task" }), catalog)).toMatchObject({
      projectId: CODEX_PENDING_PROJECT_ID,
      projectName: "待指定项目",
      kind: "pending",
      candidates: ["project-dsh", "project-other"],
    });
    expect(resolveCodexProject(thread({ cwd: "D:\\projectless" }), catalog)).toMatchObject({
      projectId: CODEX_OUTSIDE_PROJECT_ID,
      projectName: "Codex 项目外",
      kind: "outside",
    });
  });

  it("normalizes extended Windows paths for persistent workspace overrides", () => {
    expect(normalizeCodexProjectPath("\\\\?\\C:\\WORK\\skill\\"))
      .toBe("c:\\work\\skill");
    expect(resolveCodexProject(thread(), catalog, {
      byWorkspacePath: { "c:\\work\\skill\\nested": "project-dsh" },
    }).kind).toBe("explicit-override");
  });
});
