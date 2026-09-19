import { afterEach, expect, it, vi } from "vitest";
import { MaintenanceClient } from "../src/index.js";

afterEach(() => vi.useRealTimers());
function hangingClient() {
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init!.signal!;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  return { fetchImpl, client: new MaintenanceClient({ origin: "http://127.0.0.1:1", token: "fixture-secret", fetchImpl }) };
}
it("bounds a hung learning mutation without retrying or claiming it was cancelled", async () => {
  vi.useFakeTimers();
  const { client, fetchImpl } = hangingClient();
  const check = expect(client.bindLearning({ logicalSessionId: "l", codexThreadId: "c", dshRunId: "r", targetPresetId: "t", confirmed: true })).rejects.toThrow("操作结果尚未确认");
  await vi.advanceTimersByTimeAsync(45_001); await check;
  expect(fetchImpl).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});
it("bounds directory reads and preserves caller cancellation", async () => {
  vi.useFakeTimers();
  const { client } = hangingClient();
  const check = expect(client.learningDirectory()).rejects.toThrow("读取学习关联超时");
  await vi.advanceTimersByTimeAsync(45_001); await check;
  const controller = new AbortController();
  const cancelled = expect(client.learningAction("b", "collect", controller.signal)).rejects.toThrow("fixture-cancelled");
  controller.abort(new Error("fixture-cancelled")); await cancelled;
  expect(vi.getTimerCount()).toBe(0);
});
