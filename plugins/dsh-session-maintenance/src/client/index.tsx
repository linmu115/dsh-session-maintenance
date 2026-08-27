import type { ClientContext } from "./context.js";
import { createMaintenanceActions } from "./context.js";
import { installContextMenu } from "./context-menu.js";
import { openDashboard, registerOptionalSidebar } from "./dashboard-entry.js";
import { decorateSessionRows } from "./session-locator.js";
import { createActionPanel } from "./settings-actions.js";
import { installStyles } from "./styles.js";
import { verifyUiContract } from "./ui-contract.js";

export const inject = ["sessions"] as const;

export function apply(ctx: ClientContext): void {
  ctx.inject(inject, (injected) => {
    const contract = verifyUiContract(injected);
    if (!contract.compatible) {
      console.warn(`[dsh-session-maintenance] ${contract.reason}: ${contract.fingerprint}`);
      return;
    }
    const actions = createMaintenanceActions();
    const panel = createActionPanel(actions, {
      currentSessionId: () => injected.sessions.list.getSnapshot().current,
    });
    const feedbackButton = document.createElement("button");
    feedbackButton.type = "button";
    feedbackButton.className = "dsm-entry-launch";
    feedbackButton.textContent = "会话维护";
    feedbackButton.title = "打开参数与操作";
    feedbackButton.addEventListener("click", panel.open);
    document.body.appendChild(feedbackButton);
    const cleanup = [
      installStyles(),
      decorateSessionRows(injected),
      installContextMenu({
        actions,
        snapshot: () => injected.sessions.list.getSnapshot(),
        openPanel: panel.open,
        onFeedback: (message) => { feedbackButton.title = message; },
      }),
      registerOptionalSidebar(injected, () => {
        const sessionId = injected.sessions.list.getSnapshot().current;
        void openDashboard(actions, undefined, sessionId).catch((error) => { feedbackButton.title = error instanceof Error ? error.message : "无法打开看板"; });
      }),
    ];
    injected.effect(() => () => {
      for (const dispose of cleanup.reverse()) dispose();
      feedbackButton.removeEventListener("click", panel.open);
      feedbackButton.remove();
      panel.dispose();
    }, "dsh-session-maintenance: client entry");
  });
}

export * from "./context.js";
export * from "./context-menu.js";
export * from "./dashboard-entry.js";
export * from "./session-locator.js";
export * from "./settings-actions.js";
export * from "./ui-contract.js";
