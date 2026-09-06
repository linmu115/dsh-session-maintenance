import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionMenuAction, SessionMenuActionHost } from "@linmu/dsh-session-contracts";

import { installContextMenu, SESSION_MENU_ITEMS } from "../src/client/context-menu.js";
import { createMaintenanceActions, type SessionListSnapshot } from "../src/client/context.js";
import type { ProxyResult } from "../src/engine-proxy.js";

afterEach(() => vi.unstubAllGlobals());

function setup(initialHost = true) {
  const surface = Object.assign(new EventTarget(), { __dshSessionContextMenu: undefined as unknown, open: vi.fn() });
  vi.stubGlobal("window", surface);
  const documentListener = vi.fn(() => { throw new Error("Maintenance must not install a document menu"); });
  vi.stubGlobal("document", { addEventListener: documentListener });
  function makeHost() {
    let actions: readonly SessionMenuAction[] = [];
    const unregister = vi.fn();
    const host = {
      menuApiVersion: 1 as const,
      registerActions: vi.fn((_owner: string, registered: readonly SessionMenuAction[]) => { actions = registered; return unregister; }),
      action: (id: string) => actions.find((item) => item.id === id)!,
      unregister,
    } satisfies SessionMenuActionHost & { action(id: string): SessionMenuAction; unregister: typeof unregister };
    return host;
  }
  const first = makeHost();
  if (initialHost) surface.__dshSessionContextMenu = first;
  let snapshot: SessionListSnapshot = { current: "native-a", byId: { "native-a": { title: "相同标题" }, "native-b": { title: "相同标题" } } };
  const invoke = vi.fn<Parameters<typeof installContextMenu>[0]["actions"]["invoke"]>(async () => ({ ok: true, message: "已创建", url: "http://127.0.0.1/test-launch" }));
  const feedback = vi.fn();
  const dispose = installContextMenu({ actions: { invoke }, snapshot: () => snapshot, onFeedback: feedback });
  const announce = (name: "ready" | "unavailable", bridge: unknown) => surface.dispatchEvent(new CustomEvent(`dsh-session-context-menu:${name}`, { detail: { bridge } }));
  const run = (id: string, signal = new AbortController().signal) => first.action(id).run(Object.freeze({ nativeSessionId: "native-a", workspaceId: "workspace-1" }), { signal });
  return { surface, first, makeHost, dispose, announce, invoke, feedback, run, documentListener, select: (value: SessionListSnapshot) => { snapshot = value; } };
}

describe("session context menu", () => {
  it("offers phase-two plan/preview actions and no unsupported continuation mutation", () => {
    expect(SESSION_MENU_ITEMS.map((item) => item.label)).toEqual([
      "在维护看板中打开", "扫描当前 DSH 实例", "同步到 DSH / 生成安全计划", "与 Codex 版本比较", "查看版本图",
      "建立 Checkpoint", "解除映射…", "归档…", "删除候选…",
    ]);
    expect(JSON.stringify(SESSION_MENU_ITEMS)).not.toContain("延续任务");
    expect(SESSION_MENU_ITEMS.find((item) => item.id === "delete")?.operation).toBe("delete-candidate");
  });

  it("registers through the existing host and removes no native entries or listeners", () => {
    const f = setup();
    expect(f.first.registerActions).toHaveBeenCalledOnce();
    expect(f.first.registerActions.mock.calls[0]![0]).toBe("dsh-session-maintenance");
    expect(f.documentListener).not.toHaveBeenCalled();
    f.dispose();
    f.dispose();
    expect(f.first.unregister).toHaveBeenCalledOnce();
  });

  it("supports late host loading, ignores duplicate/stale events, and re-registers after reload", () => {
    const f = setup(false);
    expect(f.first.registerActions).not.toHaveBeenCalled();
    f.surface.__dshSessionContextMenu = { version: 3 };
    f.announce("ready", f.surface.__dshSessionContextMenu);
    expect(f.first.registerActions).not.toHaveBeenCalled();
    f.surface.__dshSessionContextMenu = f.first;
    f.announce("ready", f.first);
    f.announce("ready", f.first);
    expect(f.first.registerActions).toHaveBeenCalledOnce();
    const second = f.makeHost();
    f.surface.__dshSessionContextMenu = second;
    f.announce("ready", second);
    f.announce("unavailable", f.first);
    f.announce("ready", f.first);
    expect(f.first.unregister).toHaveBeenCalledOnce();
    expect(second.registerActions).toHaveBeenCalledOnce();
    expect(second.unregister).not.toHaveBeenCalled();
    f.dispose();
    f.announce("ready", second);
    expect(second.unregister).toHaveBeenCalledOnce();
    expect(second.registerActions).toHaveBeenCalledOnce();
  });

  it("uses only the frozen native ID and retains candidate deletion semantics", async () => {
    const f = setup();
    await expect(f.run("delete")).resolves.toEqual({ message: "已创建" });
    expect(f.invoke.mock.calls[0]![0]).toEqual({ operation: "delete-candidate", sessionId: "native-a" });
    expect(f.surface.open).toHaveBeenCalledOnce();
    expect(f.feedback).not.toHaveBeenCalled(); // Feedback belongs to SCM.
    f.dispose();
  });

  it("rejects same-title selection changes, removed rows and direct stale invocations", async () => {
    const f = setup();
    f.select({ current: "native-b", byId: { "native-a": { title: "相同标题" }, "native-b": { title: "相同标题" } } });
    await expect(f.run("checkpoint")).rejects.toThrow("会话选择已变化");
    f.select({ current: "native-a", byId: {} });
    expect(f.first.action("checkpoint").getState?.({ nativeSessionId: "native-a", workspaceId: null }).enabled).toBe(false);
    await expect(f.run("checkpoint")).rejects.toThrow("会话选择已变化");
    expect(f.invoke).not.toHaveBeenCalled();
    f.dispose();
  });

  it.each(["dashboard", "graph"])("cancels pending %s on consumer unload even when the server finishes", async (id) => {
    const f = setup();
    let finish!: (result: ProxyResult) => void;
    f.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const result = f.run(id);
    const rejected = expect(result).rejects.toThrow();
    expect(f.invoke.mock.calls[0]![1]?.signal?.aborted).toBe(false);
    f.dispose();
    expect(f.invoke.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    finish({ ok: true, message: "late", url: "http://127.0.0.1/late" });
    await rejected;
    expect(f.surface.open).not.toHaveBeenCalled();
  });

  it("honors host cancellation, and does not dispatch an already aborted action", async () => {
    const f = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(f.run("scan", controller.signal)).rejects.toThrow();
    expect(f.invoke).not.toHaveBeenCalled();
    f.announce("unavailable", f.first);
    await expect(f.run("checkpoint")).rejects.toThrow();
    expect(f.first.unregister).toHaveBeenCalledOnce();
    f.dispose();
  });

  it("prevents overlapping actions and surfaces active service errors to the host", async () => {
    const f = setup();
    let fail!: (error: Error) => void;
    f.invoke.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const pending = f.run("checkpoint");
    const failed = expect(pending).rejects.toThrow("Engine离线");
    await expect(f.run("sync")).rejects.toThrow("正在处理");
    expect(f.invoke).toHaveBeenCalledOnce();
    fail(new Error("Engine离线"));
    await failed;
    await expect(f.run("scan")).resolves.toEqual({ message: "已创建" });
    expect(f.invoke.mock.lastCall![0]).toEqual({ operation: "scan-current" });
    f.dispose();
  });

  it("passes cancellation to the same-origin HTTP request", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, message: "queued" })));
    const actions = createMaintenanceActions(fetchImpl);
    await actions.invoke({ operation: "scan-current" }, { signal: controller.signal });
    expect(fetchImpl.mock.calls[0]![1]?.signal).toBe(controller.signal);
    controller.abort();
    await expect(actions.invoke({ operation: "checkpoint", sessionId: "native-a" }, { signal: controller.signal })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
