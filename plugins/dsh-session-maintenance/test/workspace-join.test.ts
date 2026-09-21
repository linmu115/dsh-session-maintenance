import { expect, it, vi } from "vitest";
import {
  BrowserPendingIntentStore, VolatilePendingIntentStore, WorkspaceJoinQueue, intentKey,
  type PendingIntentStore, type WorkspaceJoinIntent,
} from "../src/client/workspace-join.js";

const intent = (over: Partial<WorkspaceJoinIntent> = {}): Omit<WorkspaceJoinIntent, "requestedAt"> => ({
  instanceId: "i-one", profileId: "web", workspaceId: "workspace-a", workspaceName: "工作区 A",
  workspacePath: "D:\\合成\\工作区A", ...over });

/** A store that records what was written, so the queue's bookkeeping is observable. */
function store(): PendingIntentStore & { readonly written: WorkspaceJoinIntent[][] } {
  const written: WorkspaceJoinIntent[][] = [];
  let current: readonly WorkspaceJoinIntent[] = [];
  return { written, list: async () => current, save: async intents => { current = [...intents]; written.push([...intents]); } };
}

it("hands the intent to the Engine when it is online", async () => {
  const pending = store();
  const deliver = vi.fn(async () => "已加入");
  const queue = new WorkspaceJoinQueue({ store: pending, deliver, clock: () => "2026-09-21T10:00:00.000Z" });
  const outcome = await queue.requestJoin(intent());
  expect(outcome.status).toBe("delivered");
  expect(outcome.message).toContain("已把 1 个工作区交给维护引擎");
  expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-a", requestedAt: "2026-09-21T10:00:00.000Z" }));
  // Nothing is left behind once the Engine accepted it.
  expect(await pending.list()).toEqual([]);
});

it("keeps the intent locally when the Engine is absent, without throwing", async () => {
  const pending = store();
  const reported: string[] = [];
  const queue = new WorkspaceJoinQueue({ store: pending, report: message => reported.push(message),
    deliver: async () => { throw new Error("维护引擎连接描述符不可用"); } });
  const outcome = await queue.requestJoin(intent());
  // The user is told it is deferred; no error escapes into the interface.
  expect(outcome.status).toBe("deferred");
  expect(outcome.message).toContain("待办");
  expect((await pending.list()).map(item => item.workspaceId)).toEqual(["workspace-a"]);
  expect(reported.join(" ")).toContain("维护引擎连接描述符不可用");
});

it("delivers what was deferred once the Engine returns", async () => {
  const pending = store();
  let online = false;
  const delivered: string[] = [];
  const queue = new WorkspaceJoinQueue({ store: pending, deliver: async value => {
    if (!online) throw new Error("引擎未运行");
    delivered.push(value.workspaceId); return "已加入";
  } });
  expect((await queue.requestJoin(intent())).status).toBe("deferred");
  expect(delivered).toEqual([]);
  online = true;
  const flushed = await queue.flush();
  expect(flushed.status).toBe("delivered");
  expect(delivered).toEqual(["workspace-a"]);
  expect(await pending.list()).toEqual([]);
  // Flushing with nothing pending is a normal outcome, not a delivery claim.
  expect((await queue.flush()).message).toContain("没有待交付");
});

it("treats a second click on the same workspace as the same intent", async () => {
  const pending = store();
  const queue = new WorkspaceJoinQueue({ store: pending, deliver: async () => { throw new Error("引擎未运行"); } });
  await queue.requestJoin(intent());
  await queue.requestJoin(intent({ workspaceName: "工作区 A（改名）" }));
  const kept = await pending.list();
  expect(kept).toHaveLength(1);
  expect(kept[0]!.workspaceName).toBe("工作区 A（改名）");
  // A different workspace is genuinely a second intent.
  await queue.requestJoin(intent({ workspaceId: "workspace-b", workspaceName: "工作区 B" }));
  expect((await pending.list()).map(item => item.workspaceId).sort()).toEqual(["workspace-a", "workspace-b"]);
  expect(intentKey({ instanceId: "i-one", profileId: "web", workspaceId: "workspace-a" }))
    .toBe(intentKey({ instanceId: "i-one", profileId: "web", workspaceId: "workspace-a" }));
});

it("stops at the first unreachable Engine and keeps the rest queued in order", async () => {
  const pending = store();
  await pending.save([
    { ...intent({ workspaceId: "a" }), requestedAt: "2026-09-21T10:00:00.000Z" },
    { ...intent({ workspaceId: "b" }), requestedAt: "2026-09-21T10:01:00.000Z" },
    { ...intent({ workspaceId: "c" }), requestedAt: "2026-09-21T10:02:00.000Z" },
  ]);
  const attempted: string[] = [];
  const queue = new WorkspaceJoinQueue({ store: pending, deliver: async value => {
    attempted.push(value.workspaceId);
    if (value.workspaceId === "b") throw new Error("引擎中途不可用");
    return "已加入";
  } });
  const outcome = await queue.flush();
  expect(outcome.status).toBe("deferred");
  // a succeeded, b failed, c was not attempted and is still queued with b.
  expect(attempted).toEqual(["a", "b"]);
  expect((await pending.list()).map(item => item.workspaceId)).toEqual(["b", "c"]);
});

it("keeps working when the browser refuses to store anything", async () => {
  // A store whose save always throws must not lose the click or the outcome.
  const brittle: PendingIntentStore = { list: async () => [], save: async () => { throw new Error("quota"); } };
  const queue = new WorkspaceJoinQueue({ store: brittle, deliver: async () => "已加入" });
  await expect(queue.requestJoin(intent())).rejects.toThrow("quota");
  // The volatile store is what a caller uses when it has nowhere durable to write.
  const volatileStore = new VolatilePendingIntentStore();
  const working = new WorkspaceJoinQueue({ store: volatileStore, deliver: async () => { throw new Error("引擎未运行"); } });
  expect((await working.requestJoin(intent())).status).toBe("deferred");
  expect((await volatileStore.list()).map(item => item.workspaceId)).toEqual(["workspace-a"]);
});

it("reads back what it stored through the browser store, tolerating junk", async () => {
  const saved = new Map<string, string>();
  const fake = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
  vi.stubGlobal("window", { localStorage: fake });
  try {
    const store = new BrowserPendingIntentStore("maintenance-key");
    expect(await store.list()).toEqual([]);
    const value: WorkspaceJoinIntent = { ...intent(), requestedAt: "2026-09-21T10:00:00.000Z" };
    await store.save([value]);
    expect(saved.get("maintenance-key")).toContain("workspace-a");
    expect(await store.list()).toEqual([value]);
    // A corrupted or foreign value reads as "nothing queued" rather than breaking the entry.
    saved.set("maintenance-key", "not json");
    expect(await store.list()).toEqual([]);
    saved.set("maintenance-key", JSON.stringify([{ nope: true }, value]));
    expect(await store.list()).toEqual([value]);
  } finally { vi.unstubAllGlobals(); }
});
