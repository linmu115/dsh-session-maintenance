// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DashboardApp } from "../src/app.js";

it("opens domain panels without requesting a global network or exposing unsafe graph deletion", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const scope = { instanceId: "synthetic", profileId: "web", namespace: "thoughtdag" };
  const object = { scope, objectId: "main-graph", writerId: "thoughtdag", title: "主干 Y", revision: 3,
    schemaVersion: 2, deleted: false, updatedAt: "2026-09-14", conflicts: 0, bytes: 100,
    content: { schemaVersion: 2, title: "主干 Y", body: { managedSchema: 2, ownerSessionId: "Y", nodes: [], edges: [], removedRelationIds: ["removed"] }, references: [] } };
  const queryKnowledgeNetwork = vi.fn(), queryKnowledgeImpact = vi.fn(), writeExtensionObject = vi.fn();
  const api = { listCanonicalWorkspaces: async () => ({ schemaVersion: 1, workspaces: [], unclassified: [] }),
    queryKnowledgeNetwork, queryKnowledgeImpact, writeExtensionObject,
    listExtensionPanels: async () => [{ scope, label: "ThoughtDAG", pluginVersion: "matched", writerId: "thoughtdag",
      configured: true, enabled: true, status: "ready", objectCount: 1, conflictCount: 0, bytes: 100,
      capabilities: { read: true, write: true, delete: true, restore: true, panel: true, context: false } }],
    listExtensionObjects: async () => ({ items: [object], nextCursor: null }),
    getExtensionObject: async () => ({ object, summary: "主干 Y · 0 个节点 · 0 条连线", conflictIds: [] }),
  };
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  const click = async (label: string) => { const target = [...node.querySelectorAll("button")].find(b => b.textContent === label); expect(target).toBeTruthy(); await act(async () => target!.click()); };
  try {
    await act(async () => root.render(<DashboardApp api={api as any} />));
    await act(async () => { await import("../src/extension-page.js"); });
    await click("扩展数据");
    await click("查看对象"); await click("打开");
    expect(node.textContent).toContain("主干 Y"); expect(node.textContent).toContain("同步停用对应引用");
    expect([...node.querySelectorAll("button")].map(b => b.textContent)).not.toContain("删除对象");
    expect(node.textContent).not.toContain("查询网络"); expect(node.textContent).not.toContain("准备重答");
    expect(queryKnowledgeNetwork).not.toHaveBeenCalled(); expect(queryKnowledgeImpact).not.toHaveBeenCalled();
    expect(writeExtensionObject).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); node.remove(); }
});
