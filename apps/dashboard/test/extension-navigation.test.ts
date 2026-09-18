import { expect, it } from "vitest";
import type { BusinessPage, ExtensionBusinessPanel } from "@linmu/dsh-session-contracts";
import { extensionCategories, extensionRegisteredViews } from "../src/extension-navigation.js";

const page = (namespace: string, sections: BusinessPage["snapshot"]["sections"] = []): BusinessPage => ({
  owner: { instanceId: "copy", profileId: "web", namespace, providerId: "settings", bootId: "550e8400-e29b-41d4-a716-446655440000" },
  online: false, updatedAt: 1, expiresAt: 2, snapshot: { title: `${namespace} 插件`, revision: 1, sections },
});
const panel = (adapterId: string, namespace = adapterId, instanceId = "copy"): ExtensionBusinessPanel => ({
  adapterId, label: `${adapterId} 栏目`, scope: { instanceId, profileId: "web" }, instanceLabel: instanceId, profileLabel: "web", status: "disabled", objectCount: 0, conflictCount: 0, bytes: 0,
  members: [{ scope: { instanceId, profileId: "web", namespace }, label: namespace, pluginVersion: "fixture", writerId: namespace, configured: false, enabled: false, status: "disabled", objectCount: 0, conflictCount: 0, bytes: 0, capabilities: null }],
});

it("uses registered adapter labels and directory references ahead of namespace membership", () => {
  const linked = page("alpha", [{ id: "data", title: "Data", kind: "data-directory", adapterId: "beta" }]);
  const result = extensionCategories([panel("alpha"), panel("beta"), panel("beta", "beta", "other")], [linked]);
  expect(result.map(item => [item.id, item.label])).toEqual([["alpha", "alpha 栏目"], ["beta", "beta 栏目"]]);
  expect(result[0]!.pages).toEqual([]);
  expect(result[1]!.pages).toEqual([linked]);
});

it("matches namespace membership only in the provider's instance and profile", () => {
  const registered = page("shared");
  const result = extensionCategories([panel("foreign", "shared", "other"), panel("local", "shared")], [registered]);
  expect(result[0]!.pages).toEqual([]);
  expect(result[1]!.pages).toEqual([registered]);
});

it("keeps offline and information-only plugins discoverable without a global information category", () => {
  const unknown = page("custom-plugin");
  const bridge = page("obsidian-bridge");
  const result = extensionCategories([], [unknown, bridge]);
  expect(result).toEqual([
    { id: "provider:custom-plugin", label: "custom-plugin 插件", pages: [unknown] },
    { id: "obsidian-series", adapterId: "obsidian-series", label: "Obsidian 系列", pages: [bridge] },
  ]);
});

it("creates no implicit information page and uses registered titles for custom pages", () => {
  expect(extensionRegisteredViews([])).toEqual([]);
  const custom = page("custom");
  const second = { ...custom, owner: { ...custom.owner, providerId: "tools" }, snapshot: { ...custom.snapshot, title: "自定义工具" } };
  const anotherInstance = { ...custom, owner: { ...custom.owner, instanceId: "other" } };
  const views = extensionRegisteredViews([custom, second, anotherInstance]);
  expect(views.map(view => view.label)).toEqual(["custom 插件", "自定义工具"]);
  expect(views[0]!.pages).toHaveLength(2);
  expect(views[1]!.pages).toEqual([second]);
});
