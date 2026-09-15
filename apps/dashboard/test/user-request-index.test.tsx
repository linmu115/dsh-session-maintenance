// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UserRequestEntry, UserRequestPage } from "../../../packages/contracts/src/index.js";
import { UserRequestIndex } from "../src/user-request-index.js";

let container: HTMLDivElement, root: Root;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
async function click(label: string) { const button = [...container.querySelectorAll("button")].find(value => value.textContent?.includes(label)); if (!button) throw new Error(`Missing ${label}`); await act(async () => button.click()); }
const entry: UserRequestEntry = { requestId: "request-stable", eventId: "event-stable", nativeMessageId: "native-message", ordinal: 1, createdAt: null, text: "真实用户补充", totalChars: 6, textOffset: 0, nextTextCursor: null, sourceTrust: "verified", attachmentRefs: [], attachmentsOmitted: 0, executionRefs: [{ id: "execution", boundaryEventId: "turn-start", endEventId: null, state: "running" }], replyRefs: [], replyRefsOmitted: 0, turnId: "turn-stable", turnBoundaryEventId: "turn-start", relation: "supplement", state: "running", associationState: "verified", location: null };
const page = (items: UserRequestEntry[] = [entry], nextCursor: string | null = null): UserRequestPage => ({ schemaVersion: 1, snapshot: "snapshot", logicalSessionId: "session", sourceVersionId: "version", referenceId: null, cutoffEventId: null, directoryOnly: true, items, nextCursor, hasMore: nextCursor !== null, remainingBytes: 5000, budgetExhausted: false });

it("does not fetch until expanded; replaces paged directory and long text without fetching reply bodies", async () => {
  const api = { getUserRequestIndex: vi.fn(async (_id, query) => query?.requestId ? page([{ ...entry, text: "长请求第二段", textOffset: 100, totalChars: 106 }]) : query?.cursor ? page([{ ...entry, requestId: "second", eventId: "second-event", text: "第二页请求" }]) : page([{ ...entry, nextTextCursor: "text-next", totalChars: 106 }], "page-next")) };
  await act(async () => root.render(<UserRequestIndex api={api} logicalSessionId="session"/>));
  expect(api.getUserRequestIndex).not.toHaveBeenCalled();
  await click("用户请求索引"); expect(container.textContent).toContain("真实用户补充"); expect(container.textContent).toContain("执行中补充");
  await click("继续读取这条长请求"); expect(container.textContent).toContain("长请求第二段"); expect(container.textContent).not.toContain("真实用户补充");
  expect(api.getUserRequestIndex.mock.calls.at(-1)?.[1]).toEqual({ requestId: "request-stable", cursor: "text-next" });
  await click("下一页请求"); expect(container.textContent).toContain("第二页请求"); expect(container.textContent).not.toContain("长请求第二段");
  await click("用户请求索引"); expect(container.querySelector(".user-request-list")).toBeNull();
});

it("cancels on collapse and refuses late data from a previous session", async () => {
  let signal: AbortSignal | undefined, resolve!: (value: UserRequestPage) => void;
  const api = { getUserRequestIndex: vi.fn((_id, _query, value) => { signal = value; return new Promise<UserRequestPage>(done => { resolve = done; }); }) };
  await act(async () => root.render(<UserRequestIndex api={api} logicalSessionId="old"/>));
  await click("用户请求索引"); await click("用户请求索引"); expect(signal?.aborted).toBe(true);
  await act(async () => resolve(page())); expect(container.textContent).not.toContain("真实用户补充");
});

it("offers a fresh first page after snapshot expiry without replaying the stale cursor", async () => {
  const api = { getUserRequestIndex: vi.fn().mockResolvedValueOnce(page([entry], "expired")).mockRejectedValueOnce(new Error("固定版本已更新")).mockResolvedValue(page([{ ...entry, text: "新版本请求" }])) };
  await act(async () => root.render(<UserRequestIndex api={api} logicalSessionId="session"/>)); await click("用户请求索引"); await click("下一页请求"); expect(container.textContent).toContain("固定版本已更新"); await click("重新加载索引"); expect(api.getUserRequestIndex.mock.calls.at(-1)?.[1]).toEqual({ limit: 10 }); expect(container.textContent).toContain("新版本请求");
});
