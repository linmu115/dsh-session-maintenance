import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { MaintenanceActions } from "../src/client/context.js";
import { ClientActionError } from "../src/client/context.js";
import type { ProxyRequest, ProxyResult } from "../src/engine-proxy.js";
import { VolatilePendingIntentStore, WorkspaceJoinQueue, type PendingIntentStore } from "../src/client/workspace-join.js";
import {
  WORKSPACE_BRIDGE_API_VERSION, WORKSPACE_BRIDGE_GLOBAL, createWorkspaceBridge, installWorkspaceBridge,
  type WorkspaceBridgeInput,
} from "../src/client/workspace-bridge.js";

/**
 * The bridge the context-menu plugin calls.
 *
 * The contract is fixed by both sides: one global name, one api version, five outcome codes and no
 * thrown errors. These tests pin exactly that, because the other side is a different plugin that
 * hides its menu entry whenever anything here drifts.
 *
 * The queue is wired here exactly as the client wires it — delivery goes back through the bridge —
 * so "the Engine is absent" means a kept intent rather than a lost click.
 */
const DECLARED = { apiVersion: 1 as const, instanceId: "i-27c4d5a7-bdb5-4b8a-8d95-6267f47499c5", profileId: "web-i27c4" };

function actionsFor(options: {
  readonly identity?: ProxyResult | ClientActionError;
  readonly join?: (request: ProxyRequest) => Promise<ProxyResult>;
}) {
  const seen: ProxyRequest[] = [];
  const actions: MaintenanceActions = {
    async invoke(request) {
      seen.push(request);
      if (request.operation === "identity") {
        if (options.identity instanceof ClientActionError) throw options.identity;
        return options.identity ?? { ok: true, message: "已读取本机实例身份", identity: { ...DECLARED, declared: true } };
      }
      if (options.join === undefined) throw new Error(`unexpected ${request.operation}`);
      return options.join(request);
    },
  };
  return { actions, seen };
}

/** The client's wiring: one store, one queue, and delivery that goes through the bridge. */
function wire(options: Parameters<typeof actionsFor>[0]) {
  const { actions, seen } = actionsFor(options);
  const store = new VolatilePendingIntentStore();
  let bridge: ReturnType<typeof createWorkspaceBridge>;
  const queue = new WorkspaceJoinQueue({ store, deliver: async intent => {
    const result = await bridge.handle.joinWorkspace({ workspaceId: intent.workspaceId,
      workspaceName: intent.workspaceName, workspacePath: intent.workspacePath });
    if (!result.ok) throw new Error(result.message);
    return result.message;
  } });
  bridge = createWorkspaceBridge({ actions, queue });
  return { actions, seen, store, queue, bridge };
}

const input: WorkspaceBridgeInput = { workspaceId: "workspace-a", workspaceName: "工作区 A", workspacePath: "D:\\合成\\工作区A" };

it("publishes apiVersion 1 and joins through the host with the resolved identity", async () => {
  const { seen, bridge } = wire({ join: async () => ({ ok: true, code: "joined", message: "已把「工作区 A」加入维护范围：映射 2 个会话" }) });
  const result = await bridge.handle.joinWorkspace(input);
  expect(WORKSPACE_BRIDGE_API_VERSION).toBe(1);
  expect(bridge.handle.apiVersion).toBe(1);
  expect(result).toEqual({ ok: true, code: "joined", message: "已把「工作区 A」加入维护范围：映射 2 个会话" });
  // The client never invents an identity: it asks the host and forwards the workspace facts.
  expect(seen[0]).toEqual({ operation: "identity" });
  expect(seen[1]).toEqual({ operation: "join-workspace", workspaceId: "workspace-a", workspaceName: "工作区 A", workspacePath: "D:\\合成\\工作区A" });
});

it("answers 'already-joined' for an idempotent repeat and nothing is queued", async () => {
  let calls = 0;
  const { store, bridge } = wire({ join: async () => {
    calls += 1;
    return calls === 1
      ? { ok: true, code: "joined", message: "已把「工作区 A」加入维护范围：映射 2 个会话" }
      : { ok: true, code: "already-joined", message: "「工作区 A」已在维护范围内：2 个会话已映射" };
  } });
  expect((await bridge.handle.joinWorkspace(input)).code).toBe("joined");
  const second = await bridge.handle.joinWorkspace(input);
  expect(second.code).toBe("already-joined");
  expect(second.ok).toBe(true);
  expect(second.message).toContain("已在维护范围内");
  expect(await store.list()).toEqual([]);
});

it("maps a stopped Engine to engine-unreachable and keeps the intent for later", async () => {
  const { store, queue, bridge } = wire({ join: async () => { throw new ClientActionError("engine-unreachable", "维护引擎离线；请先启动本机 Engine"); } });
  const result = await bridge.handle.joinWorkspace(input);
  expect(result.ok).toBe(false);
  expect(result.code).toBe("engine-unreachable");
  const kept = await store.list();
  expect(kept.map(intent => intent.workspaceId)).toEqual(["workspace-a"]);
  expect(kept[0]!.workspaceName).toBe("工作区 A");
  // A later attempt with the Engine still absent keeps it again instead of dropping it.
  expect((await queue.flush()).status).toBe("deferred");
  expect((await store.list()).map(intent => intent.workspaceId)).toEqual(["workspace-a"]);
});

it("maps an Engine refusal to engine-error and keeps the Engine's own wording", async () => {
  const { store, bridge } = wire({ join: async () => { throw new ClientActionError("engine-error", "工作区目录不在这个实例的登记范围内"); } });
  const result = await bridge.handle.joinWorkspace(input);
  expect(result).toMatchObject({ ok: false, code: "engine-error" });
  expect(result.message).toBe("工作区目录不在这个实例的登记范围内");
  // A refusal is final for this call: it is not a deferred join.
  expect(await store.list()).toEqual([]);
});

it("maps the host's invalid-input refusal to invalid-input and does not queue it", async () => {
  const { store, bridge } = wire({ join: async () => { throw new ClientActionError("invalid-input", "工作区加入只接受工作区标识、名称与目录"); } });
  expect(await bridge.handle.joinWorkspace(input)).toMatchObject({ ok: false, code: "invalid-input" });
  expect(await store.list()).toEqual([]);
});

it("refuses when the machine never declared its identity, with a message that says how", async () => {
  const { seen, store, bridge } = wire({ identity: { ok: true, message: "本机未声明实例身份",
    identity: { apiVersion: 1, instanceId: "dsh-web", profileId: "web", declared: false } } });
  const result = await bridge.handle.joinWorkspace(input);
  expect(result.ok).toBe(false);
  expect(result.code).toBe("invalid-input");
  expect(result.message).toContain("本机未声明实例身份");
  expect(result.message).toContain("cordis.patch.yml");
  // Nothing was sent to the Engine under a placeholder identity, and nothing is queued under one.
  expect(seen.map(request => request.operation)).toEqual(["identity"]);
  expect(await store.list()).toEqual([]);
});

it("treats an unreadable identity as undeclared rather than guessing one", async () => {
  const { bridge } = wire({ identity: new ClientActionError("engine-unreachable", "无法访问实例维护接口") });
  expect(await bridge.identity()).toEqual({ instanceId: "", profileId: "", declared: false });
  expect(await bridge.handle.joinWorkspace(input)).toMatchObject({ ok: false, code: "invalid-input" });
});

it("rejects an empty workspace id before asking the host anything", async () => {
  const { seen, bridge } = wire({ join: async () => ({ ok: true, code: "joined", message: "不应到达" }) });
  for (const bad of [{ workspaceId: "" }, { workspaceId: "   " }]) {
    expect(await bridge.handle.joinWorkspace(bad)).toMatchObject({ ok: false, code: "invalid-input" });
  }
  expect(seen).toEqual([]);
});

it("publishes the handle only while installed, and restores whatever was there before", () => {
  const global = {} as unknown as typeof globalThis;
  const first = wire({}).bridge;
  const second = wire({}).bridge;
  // Not loaded means not present: the menu plugin must find nothing to call.
  expect((global as unknown as Record<string, unknown>)[WORKSPACE_BRIDGE_GLOBAL]).toBeUndefined();
  const uninstallFirst = installWorkspaceBridge(global, first);
  expect((global as unknown as Record<string, unknown>)[WORKSPACE_BRIDGE_GLOBAL]).toBe(first.handle);
  const uninstallSecond = installWorkspaceBridge(global, second);
  expect((global as unknown as Record<string, unknown>)[WORKSPACE_BRIDGE_GLOBAL]).toBe(second.handle);
  uninstallSecond();
  // The older generation is back, not a dangling handle to a disposed queue.
  expect((global as unknown as Record<string, unknown>)[WORKSPACE_BRIDGE_GLOBAL]).toBe(first.handle);
  uninstallFirst();
  expect((global as unknown as Record<string, unknown>)[WORKSPACE_BRIDGE_GLOBAL]).toBeUndefined();
});

it("no longer injects an item into the context menu's DOM", () => {
  // The old path looked for [role="menu"][data-dsh-workspace-id]; that attribute exists in neither
  // the host nor the menu plugin, so the entry never appeared. The menu plugin owns the item now.
  for (const path of ["../src/client/workspace-menu.ts", "../src/client/workspace-menu-dom.ts"]) {
    expect(() => readFileSync(new URL(path, import.meta.url), "utf8"), path).toThrow();
  }
  const entry = readFileSync(new URL("../src/client/index.tsx", import.meta.url), "utf8");
  expect(entry).not.toContain("workspace-menu");
  expect(entry).not.toContain("data-dsh-workspace-id");
  expect(entry).not.toContain("CLIENT_INSTANCE_IDENTITY");
  expect(entry).toContain("installWorkspaceBridge");
});

it("delivers a queued intent through the bridge once the Engine answers", async () => {
  let reachable = false;
  const { store, queue } = wire({ join: async () => {
    if (!reachable) throw new ClientActionError("engine-unreachable", "维护引擎离线；请先启动本机 Engine");
    return { ok: true, code: "joined", message: "已加入" };
  } });
  await store.save([{ workspaceId: "workspace-queued", workspaceName: "待办工作区",
    workspacePath: "D:\\合成\\待办", requestedAt: "2026-09-21T10:00:00.000Z" }]);
  expect((await queue.flush()).status).toBe("deferred");
  expect((await store.list()).map(intent => intent.workspaceId)).toEqual(["workspace-queued"]);
  reachable = true;
  expect((await queue.flush()).status).toBe("delivered");
  expect(await store.list()).toEqual([]);
});

it("keeps an intent when the plugin's own host endpoint is unreachable", async () => {
  const store: PendingIntentStore = new VolatilePendingIntentStore();
  const failing: MaintenanceActions = { invoke: async () => { throw new ClientActionError("engine-unreachable", "无法访问实例维护接口"); } };
  const queue = new WorkspaceJoinQueue({ store, deliver: async () => { throw new Error("不适用"); } });
  createWorkspaceBridge({ actions: failing, queue });
  await store.save([{ workspaceId: "workspace-offline", workspaceName: "离线工作区", workspacePath: "D:\\合成\\离线",
    requestedAt: "2026-09-21T10:00:00.000Z" }]);
  expect((await queue.flush()).status).toBe("deferred");
  expect((await store.list()).map(intent => intent.workspaceId)).toEqual(["workspace-offline"]);
});
