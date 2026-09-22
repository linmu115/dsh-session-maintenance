// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReaderEventPage, ReaderProcessPage, ReaderTurn, SessionReaderApi, SessionReaderPage } from "../../../packages/contracts/src/index.js";
import { ReaderTurnView } from "../src/reader-process.js";
import { SessionWorkbench } from "../src/session-workbench.js";

let container: HTMLDivElement, root: Root;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
async function render(node: ReactNode) { await act(async () => root.render(node)); }
async function click(label: string) { const element = [...container.querySelectorAll("button")].find(button => button.textContent?.includes(label)); if (!element) throw new Error(`Missing ${label}`); await act(async () => element.click()); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const snapshot = "a".repeat(64);
const turn: ReaderTurn = { id: "turn-0", ordinal: 1, messages: [
  { eventId: "user", role: "user", text: "用户粘贴 Current runtime context <available_skills>", totalChars: 56, nextOffset: null },
  { eventId: "answer", role: "assistant", text: "完整的**最终回答**", totalChars: 11, nextOffset: null }],
  processCount: 3, processKinds: [{ kind: "runtime-context", label: "运行上下文", count: 1 }, { kind: "tool-call", label: "工具调用", count: 2 }] };
const processPage: ReaderProcessPage = { schemaVersion: 1, snapshot, turnId: "turn-0", items: [
  { id: "runtime", kind: "runtime-context", label: "运行上下文", eventIds: ["runtime"], paired: false },
  { id: "call", kind: "tool-call", label: "工具调用", eventIds: ["call", "result"], paired: true }], nextCursor: null };
const body = (text = "PROCESS_SECRET"): ReaderEventPage => ({ schemaVersion: 1, snapshot, eventId: "call", format: "text", text, offset: 0, totalChars: text.length, nextOffset: null });
function api(): SessionReaderApi {
  return { getSessionReader: vi.fn(), getSessionReaderProcess: vi.fn(async () => processPage), getSessionReaderEvent: vi.fn(async () => body()) };
}

it('keeps unknown data in one collapsed bundle and never requests its body when opened', async () => {
  const service = api();
  service.getSessionReaderProcess = vi.fn(async () => ({ ...processPage, items: [
    { id: 'opaque-one', kind: 'opaque-data' as const, label: '未识别数据包', eventIds: ['unknown-one', 'unknown-two'], paired: false },
  ] }));
  await render(<ReaderTurnView api={service} logicalSessionId="session" snapshot={snapshot} turn={turn} />);
  await click('本轮过程');
  const bundle = container.querySelector('.reader-process-item details') as HTMLDetailsElement;
  expect(bundle.open).toBe(false);
  expect(bundle.textContent).toContain('未识别数据包（2 条）');
  await act(async () => { bundle.open = true; bundle.dispatchEvent(new Event('toggle')); });
  expect(service.getSessionReaderEvent).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain('PROCESS_SECRET');
  expect(bundle.querySelector('pre')).toBeNull();
});
function page(id: string): SessionReaderPage {
  return { schemaVersion: 1, snapshot, turns: [turn], nextCursor: null, detail: {
    schemaVersion: 1, session: { schemaVersion: 1, id, authorityScope: "maintenance", originKind: "maintenance-native", headVersionId: null, title: id, tags: [], archivedAt: null, tombstonedAt: null, createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:00.000Z" },
    membership: null, workspace: null, projectMembership: null, project: null, projectRoots: [], headMetadata: null, nativeReferences: { schemaVersion: 1, logicalSessionId: id, references: [] }, parent: null, children: [] } } as unknown as SessionReaderPage;
}

describe("lazy reader process", () => {
  it("keeps question and final answer mounted but fetches neither process nor raw bodies until their explicit expansion", async () => {
    const service = api(); await render(<ReaderTurnView api={service} logicalSessionId="session" snapshot={snapshot} turn={turn} />);
    expect(container.textContent).toContain("用户粘贴 Current runtime context");
    expect(container.querySelector("strong")?.textContent).toBe("最终回答");
    expect(container.querySelectorAll(".safe-markdown")).toHaveLength(2);
    expect(container.querySelector("pre")).toBeNull(); expect(service.getSessionReaderProcess).not.toHaveBeenCalled(); expect(service.getSessionReaderEvent).not.toHaveBeenCalled();
    await click("本轮过程（2 次工具调用）");
    expect(service.getSessionReaderProcess).toHaveBeenCalledTimes(1); expect(service.getSessionReaderEvent).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("PROCESS_SECRET");
    await click("工具调用 · 调用与结果"); expect(service.getSessionReaderEvent).toHaveBeenCalledTimes(1); expect(container.textContent).toContain("PROCESS_SECRET");
    await click("本轮过程（2 次工具调用）"); expect(container.textContent).not.toContain("PROCESS_SECRET"); expect(container.querySelectorAll(".safe-markdown")).toHaveLength(2);
  });

  it("cancels a pending process fetch on collapse and ignores a transport that still resolves", async () => {
    const service = api(), pending = deferred<ReaderProcessPage>(); let signal: AbortSignal | undefined;
    service.getSessionReaderProcess = vi.fn((_id, _query, value) => { signal = value; return pending.promise; });
    await render(<ReaderTurnView api={service} logicalSessionId="session" snapshot={snapshot} turn={turn} />);
    await click("本轮过程（2 次工具调用）"); await click("本轮过程（2 次工具调用）"); expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(processPage)); expect(container.querySelector(".reader-process-list")).toBeNull();
  });

  it("replaces bounded result pages and aborts body work when a different paired event is selected", async () => {
    const service = api(); let signal: AbortSignal | undefined; const pending = deferred<ReaderEventPage>();
    service.getSessionReaderEvent = vi.fn((_id, eventId, query, value) => {
      if (eventId === "result") { signal = value; return pending.promise; }
      return Promise.resolve({ ...body(query.offset ? "SECOND_CHUNK" : "FIRST_CHUNK"), offset: query.offset ?? 0, totalChars: 40, nextOffset: query.offset ? null : 20 });
    });
    await render(<ReaderTurnView api={service} logicalSessionId="session" snapshot={snapshot} turn={turn} />);
    await click("本轮过程（2 次工具调用）"); await click("工具调用 · 调用与结果"); await click("继续读取");
    expect(container.textContent).toContain("SECOND_CHUNK"); expect(container.textContent).not.toContain("FIRST_CHUNK");
    await click("结果 1"); await click("本轮过程（2 次工具调用）"); expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(body("LATE_RESULT"))); expect(container.textContent).not.toContain("LATE_RESULT");
  });

  it("uses the new reader exclusively and cancels the old session when selection changes", async () => {
    const pending = deferred<SessionReaderPage>(); let oldSignal: AbortSignal | undefined;
    const service = { ...api(), listCanonicalWorkspaces: vi.fn(), getCanonicalSession: vi.fn(), getSessionReader: vi.fn((id: string, _query: unknown, signal?: AbortSignal) => { if (id === "old") { oldSignal = signal; return pending.promise; } return Promise.resolve(page(id)); }) };
    await render(<SessionWorkbench api={service} logicalSessionId="old" onOpenSession={() => undefined} />);
    await render(<SessionWorkbench api={service} logicalSessionId="new" onOpenSession={() => undefined} />);
    expect(oldSignal?.aborted).toBe(true); expect(service.getCanonicalSession).not.toHaveBeenCalled();
    await act(async () => pending.resolve(page("old"))); expect(container.querySelector("h2")?.textContent).toBe("new");
    expect(container.querySelector('[data-reader-api="paged"]')).not.toBeNull();
  });

  it("reloads a changed session with a fresh snapshot instead of repeatedly requesting the expired one", async () => {
    const refreshed = { ...page("session"), snapshot: "b".repeat(64) };
    const service = { ...api(), listCanonicalWorkspaces: vi.fn(), getCanonicalSession: vi.fn(),
      getSessionReader: vi.fn().mockResolvedValueOnce(page("session")).mockResolvedValue(refreshed),
      getSessionReaderProcess: vi.fn().mockRejectedValueOnce(new Error("会话已有更新，请重新加载后继续阅读。")).mockResolvedValue({ ...processPage, snapshot: refreshed.snapshot }) };
    await render(<SessionWorkbench api={service} logicalSessionId="session" onOpenSession={() => undefined} />);
    await click("本轮过程（2 次工具调用）"); expect(container.querySelector('[role="alert"]')?.textContent).toContain("已有更新");
    await click("重新加载会话");
    expect(service.getSessionReader).toHaveBeenCalledTimes(2);
    expect(service.getSessionReader.mock.calls.map(call => call[1])).toEqual([{}, {}]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await click("本轮过程（2 次工具调用）");
    expect(service.getSessionReaderProcess.mock.calls[1]?.[1]).toMatchObject({ snapshot: refreshed.snapshot });
    expect(service.getCanonicalSession).not.toHaveBeenCalled();
  });
});
