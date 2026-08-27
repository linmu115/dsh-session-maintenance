import { describe, expect, it } from "vitest";

import { SESSION_MENU_ITEMS } from "../src/client/context-menu.js";

describe("session context menu", () => {
  it("offers phase-two plan/preview actions and no unsupported continuation mutation", () => {
    expect(SESSION_MENU_ITEMS.map((item) => item.label)).toEqual([
      "在维护看板中打开", "扫描此会话", "同步到 DSH / 生成安全计划", "与 Codex 版本比较", "查看版本图",
      "建立 Checkpoint", "解除映射…", "归档…", "删除候选…", "维护参数与操作…",
    ]);
    expect(JSON.stringify(SESSION_MENU_ITEMS)).not.toContain("延续任务");
    expect(SESSION_MENU_ITEMS.find((item) => item.id === "delete")?.operation).toBe("delete-candidate");
  });
});
