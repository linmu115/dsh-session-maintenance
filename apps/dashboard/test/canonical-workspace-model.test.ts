import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import type { CanonicalDashboardEvent, CanonicalEventV1, CanonicalWorkspaceDirectory } from "@linmu/dsh-session-contracts";

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

  it("prunes empty branches while retaining every ancestor of a populated descendant", () => {
    const entry = (id: string, parentId: string | null, populated = false) => ({
      workspace: { schemaVersion: 1, id, parentId, name: id, sortKey: id, deletedAt: null, createdAt: at, updatedAt: at },
      sessions: populated ? [session("live", "maintenance-native")] : [],
    });
    const directory = { schemaVersion: 1, workspaces: [entry("root", null), entry("middle", "root"),
      entry("leaf", "middle", true), entry("empty-child", "root"), entry("empty-root", null),
      entry("empty-grandchild", "empty-root")], unclassified: [] } as unknown as CanonicalWorkspaceDirectory;
    const tree = buildCanonicalWorkspaceTree(directory);
    expect(tree.map(node => node.workspace.id)).toEqual(["root"]);
    expect(tree[0]?.children.map(node => node.workspace.id)).toEqual(["middle"]);
    expect(tree[0]?.children[0]?.children.map(node => node.workspace.id)).toEqual(["leaf"]);
    expect(tree[0]?.children[0]?.children[0]?.sessions[0]?.session.id).toBe("live");
    expect(directory.workspaces).toHaveLength(6);
    expect(buildCanonicalWorkspaceTree({ ...directory, workspaces: directory.workspaces.map(item => ({ ...item, sessions: [] })) })).toEqual([]);
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
    const message = { ...unknown, id: "event-message", kind: "assistant-message", role: "assistant", readableText: unknown.content } as CanonicalDashboardEvent;
    expect(canonicalEventPresentation(message)).toEqual({ heldOut: false, text: "<img src=x onerror=alert(1)>" });
    const html = renderToStaticMarkup(createElement(CanonicalEventView, { event: message }));
    expect(html).toContain("&lt;img"); // Raw inspection is escaped text, never executable markup.
    expect(html).not.toContain("<img");

    const other = {
      ...unknown,
      id: "event-other",
      kind: "other",
      content: {
        schemaVersion: 1,
        type: "other",
        reason: "no-common-semantics",
        sourceKind: "codex/unknown",
        label: "未映射记录",
        summary: "仅作为维护记录展示。",
        evidenceRef: null,
      },
    } as CanonicalEventV1;
    expect(canonicalEventPresentation(other)).toEqual({ heldOut: true, text: "仅作为维护记录展示。" });
  });

  it("folds supporting records", () => {
    for (const kind of ["reasoning", "tool-call", "tool-result", "system-metadata"] as const) {
      const event = { id: kind, kind, role: "assistant", sequence: 1, source: { platform: "dsh", instanceId: "synthetic" }, content: "supporting record", rawPayload: null } as CanonicalEventV1;
      const html = renderToStaticMarkup(createElement(CanonicalEventView, { event }));
      expect(html).toContain('<details class="event-supporting">');
      expect(html).not.toContain(" open=");
    }
  });

  it("renders only query-provided readable text without inspecting opaque message evidence", () => {
    const event: CanonicalDashboardEvent = { schemaVersion: 1, id: "readable-assistant", logicalSessionId: "logical-synthetic" as never,
      kind: "assistant-message", role: "assistant", sequence: 1, contentDigest: "sha256:synthetic", extensions: {},
      source: { platform: "dsh", instanceId: "synthetic", sessionId: "native-synthetic", eventId: null, cursor: null }, content: { opaque: { text: "source evidence" } },
      readableText: "hello", rawPayload: null,
    };
    const html = renderToStaticMarkup(createElement(CanonicalEventView, { event }));
    expect(html).toMatch(/<div class="safe-markdown"[^>]*><p>hello<\/p><\/div>/u);
    expect(html).not.toContain('<p>source evidence</p>');
    const unavailable = renderToStaticMarkup(createElement(CanonicalEventView, { event: { ...event, readableText: null } }));
    expect(unavailable).toContain("这条消息没有可显示的文字");
    expect(unavailable).not.toContain('class="safe-markdown"');
    const { readableText: _text, ...legacyEvent } = event;
    const legacy = renderToStaticMarkup(createElement(CanonicalEventView, { event: legacyEvent }));
    expect(legacy).toContain("当前引擎未提供可读正文");
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
