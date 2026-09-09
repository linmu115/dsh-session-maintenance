import type { ClientContext } from "./context.js";
import { createMaintenanceActions } from "./context.js";
import { installContextMenu } from "./context-menu.js";
import { openDashboard, registerOptionalSidebar } from "./dashboard-entry.js";
import { decorateSessionRows } from "./session-locator.js";
import { registerSettingsSection } from "./settings-actions.js";
import { installStyles } from "./styles.js";
import { verifyUiContract } from "./ui-contract.js";

export const inject = ["sessions", "slots"] as const;

export function apply(ctx: ClientContext): void {
  ctx.inject(inject, (injected) => {
    const actions = createMaintenanceActions();
    const cleanup = [
      installStyles(),
      registerSettingsSection(injected.slots, {
        actions,
        currentSessionId: () => injected.sessions.list.getSnapshot().current,
      }),
      registerOptionalSidebar(injected, () => {
        void openDashboard(actions).catch((error) => {
          console.warn("[dsh-session-maintenance] 无法打开看板", error);
        });
      }),
      // SCM owns row discovery and exact selection. Its API does not depend on
      // Maintenance's optional legacy row decoration selectors.
      installContextMenu({
        actions,
        snapshot: () => injected.sessions.list.getSnapshot(),
        onFeedback: (message) => { console.info(`[dsh-session-maintenance] ${message}`); },
      }),
    ];
    const contract = verifyUiContract(injected);
    if (!contract.compatible) {
      console.warn(`[dsh-session-maintenance] ${contract.reason}: ${contract.fingerprint}`);
    } else {
      cleanup.push(
        decorateSessionRows(injected),
      );
    }
    injected.effect(() => () => {
      for (const dispose of cleanup.reverse()) dispose();
    }, "dsh-session-maintenance: client entry");
  });
}

export * from "./context.js";
export * from "./context-menu.js";
export * from "./dashboard-entry.js";
export * from "./session-locator.js";
export * from "./settings-actions.js";
export * from "./ui-contract.js";
export * from "./other-event-card.js";
