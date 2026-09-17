// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LearningPage, type LearningApi } from "../src/learning-page.js";
import type { LearningDirectory } from "@linmu/dsh-session-contracts";
const roots: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of roots.splice(0)) await close(); });
async function mount(api: LearningApi) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  roots.push(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<LearningPage api={api} />)); return container;
}
const directory: LearningDirectory = { targets: [], candidates: [], bindings: [{ id: "b", logicalSessionId: "l", title: "Synthetic lesson", targetPresetId: "t", codexThreadId: "c", dshInstanceId: "d", dshProfileId: "web", dshNativeSessionId: "n", state: "sent", message: "等待回收", sentAt: null, collectedAt: null, revision: 0, blockedReason: null }] };
it("shows recoverable errors and disables duplicate actions during collection", async () => {
  let reject!: (e: Error) => void;
  const learningAction = vi.fn(() => new Promise<never>((_, r) => { reject = r; }));
  const container = await mount({ learningDirectory: async () => directory, bindLearning: vi.fn(), learningAction });
  const collect = [...container.querySelectorAll("button")].find(b => b.textContent === "回收 Codex 会话")!;
  await act(async () => collect.click()); expect(collect.disabled).toBe(true); expect(learningAction).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error("DSH 已变化，禁止追加")));
  expect(container.querySelector('[role="alert"]')!.textContent).toContain("DSH 已变化"); expect(collect.disabled).toBe(false);
});
it("blocks actions on an active DSH and never auto-binds candidates", async () => {
  const bindLearning = vi.fn(), learningAction = vi.fn();
  const container = await mount({ learningDirectory: async () => ({ ...directory, bindings: [{ ...directory.bindings[0]!, blockedReason: "请正常停止 DSH" }] }), bindLearning, learningAction });
  const collect = [...container.querySelectorAll("button")].find(b => b.textContent === "回收 Codex 会话")!;
  expect(collect.disabled).toBe(true); expect(container.textContent).toContain("请正常停止 DSH"); expect(bindLearning).not.toHaveBeenCalled();
});
