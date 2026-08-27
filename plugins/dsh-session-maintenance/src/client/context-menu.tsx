import type { MaintenanceActions, SessionListSnapshot } from "./context.js";
import { openDashboard } from "./dashboard-entry.js";
import { sessionIdFromEvent } from "./session-locator.js";

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly operation?: "scan-current" | "sync-current" | "compare" | "graph" | "checkpoint" | "unlink-candidate" | "archive-candidate" | "delete-candidate";
  readonly dashboard?: true;
  readonly panel?: true;
}

export const SESSION_MENU_ITEMS: readonly MenuItem[] = [
  { id: "dashboard", label: "在维护看板中打开", dashboard: true },
  { id: "scan", label: "扫描此会话", operation: "scan-current" },
  { id: "sync", label: "同步到 DSH / 生成安全计划", operation: "sync-current" },
  { id: "compare", label: "与 Codex 版本比较", operation: "compare" },
  { id: "graph", label: "查看版本图", operation: "graph" },
  { id: "checkpoint", label: "建立 Checkpoint", operation: "checkpoint" },
  { id: "unlink", label: "解除映射…", operation: "unlink-candidate" },
  { id: "archive", label: "归档…", operation: "archive-candidate" },
  { id: "delete", label: "删除候选…", operation: "delete-candidate" },
  { id: "settings", label: "维护参数与操作…", panel: true },
] as const;

export function installContextMenu(input: {
  readonly actions: MaintenanceActions;
  readonly instanceId?: string;
  readonly snapshot: () => SessionListSnapshot;
  readonly openPanel: () => void;
  readonly onFeedback: (message: string) => void;
}): () => void {
  let menu: HTMLElement | undefined;
  let pending = false;
  const close = () => { menu?.remove(); menu = undefined; };
  const invoke = async (item: MenuItem, sessionId: string) => {
    if (pending) return;
    pending = true;
    close();
    try {
      if (item.panel === true) { input.openPanel(); return; }
      if (item.dashboard === true) { input.onFeedback(await openDashboard(input.actions, input.instanceId, sessionId)); return; }
      if (item.operation === undefined) return;
      const result = await input.actions.invoke({
        operation: item.operation,
        ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
        ...(item.operation === "scan-current" ? {} : { sessionId }),
        ...(item.operation === "sync-current" ? { applySafe: true } : {}),
      });
      if (result.url !== undefined) window.open(result.url, "_blank", "noopener,noreferrer");
      input.onFeedback(`${result.message}${result.jobId ?? result.planId ? ` · ${result.jobId ?? result.planId}` : ""}`);
    } catch (error) {
      input.onFeedback(error instanceof Error ? error.message : "维护操作失败");
    } finally { pending = false; }
  };
  const contextmenu = (event: MouseEvent) => {
    const sessionId = sessionIdFromEvent(event.target);
    if (sessionId === undefined || input.snapshot().byId?.[sessionId] === undefined) return;
    event.preventDefault();
    close();
    const element = document.createElement("div");
    element.className = "dsm-entry-menu";
    element.style.left = `${Math.min(event.clientX, window.innerWidth - 280)}px`;
    element.style.top = `${Math.min(event.clientY, window.innerHeight - 420)}px`;
    element.setAttribute("role", "menu");
    for (const item of SESSION_MENU_ITEMS) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.label;
      button.addEventListener("click", () => void invoke(item, sessionId), { once: true });
      element.appendChild(button);
    }
    document.body.appendChild(element);
    menu = element;
  };
  const click = () => close();
  document.addEventListener("contextmenu", contextmenu);
  document.addEventListener("click", click);
  return () => { close(); document.removeEventListener("contextmenu", contextmenu); document.removeEventListener("click", click); };
}
