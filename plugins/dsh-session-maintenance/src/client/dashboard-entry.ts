import { createElement, useEffect, type ReactNode } from 'react';
import type { ClientContext, MaintenanceActions } from "./context.js";

export async function openDashboard(actions: MaintenanceActions, instanceId?: string, sessionId?: string,
  signal?: AbortSignal, target?: 'same-tab'): Promise<string> {
  signal?.throwIfAborted();
  try {
    const result = await actions.invoke({
      operation: "dashboard",
      ...(instanceId === undefined ? {} : { instanceId }),
      ...(sessionId === undefined ? {} : { sessionId }),
    }, signal === undefined ? undefined : { signal });
    signal?.throwIfAborted();
    if (result.url === undefined) throw new Error("维护引擎没有返回 Dashboard 启动链接");
    const url = new URL(result.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/ui/claim') {
      throw new Error('维护引擎返回了无效的本机看板地址');
    }
    if (target === 'same-tab') window.location.assign(url.href);
    else if (!window.open(url.href, '_blank', 'noopener,noreferrer')) {
      throw new Error('浏览器未允许打开新标签页，请在设置中使用“启动看板”');
    }
    return result.message;
  } catch (error) { throw error; }
}

interface BetterSidebarLike {
  registerTab(input: { id: string; title: string; order: number; single: boolean; component: () => ReactNode }): () => void;
}

export function registerOptionalSidebar(ctx: ClientContext, open: () => void): () => void {
  const value = ctx.get("betterSidebar") as Partial<BetterSidebarLike> | undefined;
  if (typeof value?.registerTab !== "function") return () => undefined;
  return value.registerTab({
    id: "dsh-session-maintenance",
    title: "会话维护",
    order: 45,
    single: true,
    component: function MaintenanceDashboardTab() {
      useEffect(() => { open(); }, []);
      return createElement('button', { type: 'button', onClick: open }, '打开会话维护看板');
    },
  });
}
