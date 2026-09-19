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
it('shows the image filtering policy and the stored skipped-image count',async()=>{
  const container=await mount({learningDirectory:async()=>({...directory,bindings:[{...directory.bindings[0]!,imageNotice:'本次同步跳过 2 张图片，仅发送文字；原图片保留。'}]}),bindLearning:vi.fn(),learningAction:vi.fn()});
  expect(container.textContent).toContain('本次同步跳过 2 张图片');expect(container.textContent).toContain('[图片已跳过]');
});
it("shows recoverable errors and disables duplicate actions during collection", async () => {
  let reject!: (e: Error) => void;
  const learningAction = vi.fn(() => new Promise<never>((_, r) => { reject = r; }));
  const container = await mount({ learningDirectory: async () => directory, bindLearning: vi.fn(), learningAction });
  const collect = [...container.querySelectorAll("button")].find(b => b.textContent === "回收 Codex 会话")!;
  await act(async () => collect.click()); expect(collect.disabled).toBe(true); expect(learningAction).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error("DSH 已变化，禁止追加")));
  expect(container.querySelector('[role="alert"]')!.textContent).toContain("DSH 已变化"); expect(collect.disabled).toBe(false);
  expect(collect.closest("article")!.querySelector('[role="alert"]')!.textContent).toContain("DSH 已变化");
});
it("blocks actions on an active DSH and never auto-binds candidates", async () => {
  const bindLearning = vi.fn(), learningAction = vi.fn();
  const container = await mount({ learningDirectory: async () => ({ ...directory, bindings: [{ ...directory.bindings[0]!, blockedReason: "请正常停止 DSH" }] }), bindLearning, learningAction });
  const collect = [...container.querySelectorAll("button")].find(b => b.textContent === "回收 Codex 会话")!;
  expect(collect.disabled).toBe(true); expect(container.textContent).toContain("请正常停止 DSH"); expect(bindLearning).not.toHaveBeenCalled();
});
const available: LearningDirectory = { bindings: [], targets: [{ id: "t", label: "Codex", codexInstanceId: "codex" }],
  candidates: [{ logicalSessionId: "l", title: "Synthetic lesson", codexThreadId: "c", codexInstanceId: "codex", dshRunId: "r", dshLabel: "DSH", blockedReason: null }] };
async function choose(container: HTMLElement) {
  const [candidate, target] = [...container.querySelectorAll("select")];
  await act(async () => { candidate!.value = "l:r"; candidate!.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { target!.value = "t"; target!.dispatchEvent(new Event("change", { bubbles: true })); });
}
it("explains active-instance and target blockers before enabling confirmation", async () => {
  const bindLearning = vi.fn();
  let data: LearningDirectory = { ...available, candidates: [{ ...available.candidates[0]!, blockedReason: "请先正常停止对应 DSH 实例" }] };
  const container = await mount({ learningDirectory: async () => data, bindLearning, learningAction: vi.fn() });
  await choose(container);
  expect(container.textContent).toContain("请先正常停止对应 DSH 实例");
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
  data = { ...available, candidates: [{ ...available.candidates[0]!, codexInstanceId: "another-codex", blockedReason: null }] };
  await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "刷新状态")!.click());
  expect(container.textContent).toContain("所选 Codex 目标与会话来源不一致");
  expect(bindLearning).not.toHaveBeenCalled();
});
it("exits the binding busy state on timeout and invalidates candidates after a failed refresh", async () => {
  let reject!: (error: Error) => void;
  let reads = 0;
  const bindLearning = vi.fn(() => new Promise<never>((_resolve, r) => { reject = r; }));
  const container = await mount({ learningDirectory: async () => { if (++reads > 1) throw new Error("读取学习关联超时"); return available; }, bindLearning, learningAction: vi.fn() });
  await choose(container);
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  const button = [...container.querySelectorAll("button")].find(b => b.textContent === "核对并加入")!;
  await act(async () => button.click());
  expect(button.textContent).toBe("正在核对关联…");
  await act(async () => reject(new Error("等待响应超时，操作结果尚未确认")));
  expect(button.textContent).toBe("核对并加入");
  expect(button.disabled).toBe(true);
  expect(container.querySelector('[role="alert"]')!.textContent).toContain("读取学习关联超时");
  expect(container.querySelector('[role="alert"]')!.textContent).toContain("操作结果尚未确认");
  expect(bindLearning).toHaveBeenCalledTimes(1);
});
