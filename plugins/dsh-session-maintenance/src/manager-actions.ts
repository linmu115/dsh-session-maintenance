import type { RestrictedEngineProxy } from "./engine-proxy.js";

export const PACKAGE_NAME = "dsh-session-maintenance";
export const MANAGER_ACTIONS = {
  openDashboard: "dashboard.open",
  checkEngine: "engine.check",
  scanSessions: "sessions.scan",
} as const;

type ActionResult = { readonly ok?: boolean; readonly message: string; readonly restartRequired?: boolean };
type DeferredTask = () => void | Promise<void>;

export interface ResourceManagementActionsLike {
  register(packageName: string, actionId: string, handler: () => Promise<ActionResult>): () => void;
  deferUntilResponse?(task: DeferredTask): void;
}

export interface ManagerActionContext {
  readonly resourceManagementActions: ResourceManagementActionsLike;
  effect(callback: () => void | (() => void), label?: string): void;
}

export function registerManagerActions(
  ctx: ManagerActionContext,
  proxy: Pick<RestrictedEngineProxy, "invoke">,
  openDashboard: (url: string) => Promise<void>,
): void {
  ctx.effect(() => ctx.resourceManagementActions.register(
    PACKAGE_NAME,
    MANAGER_ACTIONS.openDashboard,
    async () => {
      const result = await proxy.invoke({ operation: "dashboard" });
      const url = result.url;
      if (url === undefined) return { ok: false, message: "维护引擎没有返回可用的看板入口" };
      const task = () => openDashboard(url);
      if (ctx.resourceManagementActions.deferUntilResponse !== undefined) {
        ctx.resourceManagementActions.deferUntilResponse(task);
      } else {
        await task();
      }
      return { message: "完整会话维护看板已在默认浏览器打开" };
    },
  ), "dsh-session-maintenance: Manager dashboard action");

  ctx.effect(() => ctx.resourceManagementActions.register(
    PACKAGE_NAME,
    MANAGER_ACTIONS.checkEngine,
    async () => proxy.invoke({ operation: "status" }),
  ), "dsh-session-maintenance: Manager engine check action");

  ctx.effect(() => ctx.resourceManagementActions.register(
    PACKAGE_NAME,
    MANAGER_ACTIONS.scanSessions,
    async () => proxy.invoke({ operation: "scan-current" }),
  ), "dsh-session-maintenance: Manager scan action");
}
