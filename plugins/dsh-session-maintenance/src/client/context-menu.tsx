import type { SessionMenuAction, SessionMenuActionHost, SessionMenuTarget } from "@linmu/dsh-session-contracts";

import type { MaintenanceActions, SessionListSnapshot } from "./context.js";
import { openDashboard } from "./dashboard-entry.js";

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly operation?: "scan-current" | "sync-current" | "compare" | "graph" | "checkpoint" | "unlink-candidate" | "archive-candidate" | "delete-candidate";
  readonly dashboard?: true;
}

export const SESSION_MENU_ITEMS: readonly MenuItem[] = [
  { id: "dashboard", label: "在维护看板中打开", dashboard: true },
  { id: "scan", label: "扫描当前 DSH 实例", operation: "scan-current" },
  { id: "sync", label: "同步到 DSH / 生成安全计划", operation: "sync-current" },
  { id: "compare", label: "与 Codex 版本比较", operation: "compare" },
  { id: "graph", label: "查看版本图", operation: "graph" },
  { id: "checkpoint", label: "建立 Checkpoint", operation: "checkpoint" },
  { id: "unlink", label: "解除映射…", operation: "unlink-candidate" },
  { id: "archive", label: "归档…", operation: "archive-candidate" },
  { id: "delete", label: "删除候选…", operation: "delete-candidate" },
] as const;

const READY = "dsh-session-context-menu:ready";
const UNAVAILABLE = "dsh-session-context-menu:unavailable";
type MenuWindow = Window & { readonly __dshSessionContextMenu?: unknown };

function isHost(value: unknown): value is SessionMenuActionHost {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SessionMenuActionHost>;
  return candidate.menuApiVersion === 1 && typeof candidate.registerActions === "function";
}

/** Register with SCM. Settings/sidebar remain available when SCM is absent. */
export function installContextMenu(input: {
  readonly actions: MaintenanceActions;
  readonly instanceId?: string;
  readonly snapshot: () => SessionListSnapshot;
  readonly onFeedback: (message: string) => void;
}): () => void {
  const surface = window as MenuWindow;
  let current: SessionMenuActionHost | undefined;
  let disconnect: (() => void) | undefined;
  let disposed = false;

  const connect = (candidate: unknown) => {
    if (disposed || !isHost(candidate) || candidate === current || candidate !== surface.__dshSessionContextMenu) return;
    const controller = new AbortController();
    let pending = false;
    const getState = (target: SessionMenuTarget) => {
      const snapshot = input.snapshot();
      if (controller.signal.aborted) return { enabled: false, disabledReason: "维护菜单已卸载" };
      if (snapshot.current !== target.nativeSessionId || snapshot.byId?.[target.nativeSessionId] === undefined) {
        return { enabled: false, disabledReason: "会话选择已变化，请重新打开菜单" };
      }
      return pending ? { enabled: false, disabledReason: "维护操作正在处理" } : { enabled: true };
    };
    const actions: SessionMenuAction[] = SESSION_MENU_ITEMS.map((item) => ({
      id: item.id,
      label: item.label,
      getState,
      run: async (target, options) => {
        const signal = AbortSignal.any([options.signal, controller.signal]);
        signal.throwIfAborted();
        const state = getState(target);
        if (!state.enabled) throw new Error(state.disabledReason);
        pending = true;
        try {
          if (item.dashboard === true) {
            const message = await openDashboard(input.actions, input.instanceId, target.nativeSessionId, signal);
            return { message };
          }
          if (item.operation === undefined) return;
          const result = await input.actions.invoke({
            operation: item.operation,
            ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
            ...(item.operation === "scan-current" ? {} : { sessionId: target.nativeSessionId }),
            ...(item.operation === "sync-current" ? { applySafe: true } : {}),
          }, { signal });
          signal.throwIfAborted();
          if (result.url !== undefined) window.open(result.url, "_blank", "noopener,noreferrer");
          return { message: `${result.message}${result.jobId ?? result.planId ? ` · ${result.jobId ?? result.planId}` : ""}` };
        } finally { pending = false; }
      },
    }));
    let unregister: () => void;
    try { unregister = candidate.registerActions("dsh-session-maintenance", actions); }
    catch (error) {
      controller.abort();
      input.onFeedback(error instanceof Error ? error.message : "无法接入统一菜单；可从设置打开维护看板");
      return;
    }
    disconnect?.();
    current = candidate;
    disconnect = () => { controller.abort(); unregister(); };
  };
  const ready = (event: Event) => connect((event as CustomEvent<{ readonly bridge?: unknown }>).detail?.bridge);
  const unavailable = (event: Event) => {
    if ((event as CustomEvent<{ readonly bridge?: unknown }>).detail?.bridge !== current) return;
    disconnect?.();
    disconnect = undefined;
    current = undefined;
  };
  // Listen before discovery so either plugin loading order is supported.
  surface.addEventListener(READY, ready);
  surface.addEventListener(UNAVAILABLE, unavailable);
  connect(surface.__dshSessionContextMenu);
  return () => {
    if (disposed) return;
    disposed = true;
    surface.removeEventListener(READY, ready);
    surface.removeEventListener(UNAVAILABLE, unavailable);
    disconnect?.();
    disconnect = undefined;
    current = undefined;
  };
}
