import type { ClientContext, MaintenanceActions } from "./context.js";

export async function openDashboard(actions: MaintenanceActions, instanceId?: string, sessionId?: string): Promise<string> {
  const result = await actions.invoke({
    operation: "dashboard",
    ...(instanceId === undefined ? {} : { instanceId }),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  if (result.url === undefined) throw new Error("维护引擎没有返回 Dashboard 启动链接");
  window.open(result.url, "_blank", "noopener,noreferrer");
  return result.message;
}

interface BetterSidebarLike {
  registerTab(input: { id: string; title: string; order: number; single: boolean; component: () => null }): () => void;
}

export function registerOptionalSidebar(ctx: ClientContext, open: () => void): () => void {
  const value = ctx.get("betterSidebar") as Partial<BetterSidebarLike> | undefined;
  if (typeof value?.registerTab !== "function") return () => undefined;
  return value.registerTab({
    id: "dsh-session-maintenance",
    title: "会话维护",
    order: 45,
    single: true,
    component: () => { queueMicrotask(open); return null; },
  });
}
