import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import type { CanonicalEventV1, CanonicalWorkspaceDirectory } from "@linmu/dsh-session-contracts";

import { CanonicalEventView, canonicalEventPresentation } from "../src/canonical-event-view.js";
import { canonicalOriginLabel } from "../src/canonical-labels.js";
import { buildCanonicalProjectDirectory } from "../src/project-directory.js";
import { buildCanonicalWorkspaceTree } from "../src/workspace-directory.js";

const at = "2026-08-31T00:00:00.000Z";

function session(id: string, originKind: "codex-mirror" | "maintenance-native" | "codex-derived") {
  return {
    session: { schemaVersion: 1, id, authorityScope: originKind === "codex-mirror" ? "codex" : "maintenance", originKind, headVersionId: null, title: "同名会话", tags: [], archivedAt: null, tombstonedAt: null, createdAt: at, updatedAt: at },
    membership: null,
  } as never;
}

describe("canonical dashboard workspace model", () => {
  it("builds nested logical workspaces and keeps same-title origins distinguishable", () => {
    const directory: CanonicalWorkspaceDirectory = {
      schemaVersion: 1,
      workspaces: [
        { workspace: { schemaVersion: 1, id: "workspace-child", parentId: "workspace-root", name: "子目录", sortKey: "b", deletedAt: null, createdAt: at, updatedAt: at }, sessions: [session("maintenance-1", "maintenance-native")] },
        { workspace: { schemaVersion: 1, id: "workspace-root", parentId: null, name: "根目录", sortKey: "a", deletedAt: null, createdAt: at, updatedAt: at }, sessions: [session("codex-1", "codex-mirror")] },
      ],
      unclassified: [session("derived-1", "codex-derived")],
    } as never;
    const tree = buildCanonicalWorkspaceTree(directory);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.workspace.id).toBe("workspace-root");
    expect(tree[0]?.children[0]?.workspace.id).toBe("workspace-child");
    expect([canonicalOriginLabel(tree[0]!.sessions[0]!.session.originKind), canonicalOriginLabel(directory.unclassified[0]!.session.originKind)]).toEqual(["Codex 同步", "Codex 派生"]);
  });

  it("holds unknown events out and discards historical HTML from Markdown", () => {
    const unknown = {
      schemaVersion: 1, id: "event-unknown", logicalSessionId: "logical-1", sequence: 0,
      kind: "opaque-unknown", role: "unknown", content: "<img src=x onerror=alert(1)>",
      source: { platform: "dsh", instanceId: "fixture", sessionId: "native-1", eventId: null, cursor: null },
      contentDigest: "sha256:unknown", rawPayload: null, extensions: {},
    } as CanonicalEventV1;
    expect(canonicalEventPresentation(unknown)).toEqual({
      heldOut: true,
      text: "此事件类型未被当前适配器解释，原始数据已留置且不会执行。",
    });
    const message = { ...unknown, id: "event-message", kind: "assistant-message", role: "assistant" } as CanonicalEventV1;
    expect(canonicalEventPresentation(message)).toEqual({ heldOut: false, text: "<img src=x onerror=alert(1)>" });
    const html = renderToStaticMarkup(createElement(CanonicalEventView, { event: message }));
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<img src=x");
  });

  it("groups sessions by project while preserving workspace as separate detail", () => {
    const directory = {
      schemaVersion: 1,
      projects: [{
        project: { schemaVersion: 1, id: "project-skill", name: "Skill 管理", sourcePlatform: "codex", sourceProjectId: "skill", sortKey: "a", deletedAt: null, createdAt: at, updatedAt: at },
        roots: [{ schemaVersion: 1, projectId: "project-skill", path: "D:/AI/Skill", normalizedPath: "d:/ai/skill", ordinal: 0 }],
        sessions: [session("codex-1", "codex-mirror")],
      }],
      unclassified: [session("maintenance-1", "maintenance-native")],
    } as never;
    const groups = buildCanonicalProjectDirectory(directory);
    expect(groups.map((entry) => [entry.project?.name ?? null, entry.sessions.length])).toEqual([
      ["Skill 管理", 1],
      [null, 1],
    ]);
  });
});
