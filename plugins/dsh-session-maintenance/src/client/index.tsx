import type { ClientContext } from "./context.js";
import { createMaintenanceActions } from "./context.js";
import { installContextMenu } from "./context-menu.js";
import { openDashboard, registerOptionalSidebar } from "./dashboard-entry.js";
import { decorateSessionRows } from "./session-locator.js";
import { registerSettingsSection } from "./settings-actions.js";
import { installStyles } from "./styles.js";
import { verifyUiContract } from "./ui-contract.js";
import { BrowserPendingIntentStore, WorkspaceJoinQueue } from "./workspace-join.js";
import { observeSessions, reportSessionChanges, sessionSyncIntents } from "./session-change-report.js";
import { createWorkspaceBridge, installWorkspaceBridge } from "./workspace-bridge.js";

export const inject = ["sessions", "slots"] as const;

/**
 * The instance-side entry point for "add this workspace to sessionmaintenance".
 *
 * The menu itself belongs to the context-menu plugin: it renders the workspace right-click menu,
 * and its DOM carries no attribute this plugin could recognize, so injecting an item was never
 * going to work. What this plugin owns instead is the half the menu cannot do for itself — the
 * authenticated Engine connection — published as one global handle the menu calls
 * (`globalThis.dshSessionMaintenance`, see `workspace-bridge.ts`).
 */
export function apply(ctx: ClientContext): void {
  ctx.inject(inject, (injected) => {
    const actions = createMaintenanceActions();
    const feedback = (message: string) => { console.info(`[dsh-session-maintenance] ${message}`); };
    // The entry has to work while the Engine is down, so the pending intent is durable and the
    // delivery attempt is what may fail. Delivery always goes through the bridge, which is the
    // only path that knows this instance's real identity.
    let bridge: ReturnType<typeof createWorkspaceBridge>;
    const joinQueue = new WorkspaceJoinQueue({ store: new BrowserPendingIntentStore(), report: feedback,
      deliver: async intent => {
        const result = await bridge.handle.joinWorkspace({ workspaceId: intent.workspaceId,
          workspaceName: intent.workspaceName, workspacePath: intent.workspacePath });
        // A deferred outcome must still throw, or the queue would drop the intent it just kept.
        if (!result.ok) throw new Error(result.message);
        return result.message;
      } });
    bridge = createWorkspaceBridge({ actions, queue: joinQueue, report: feedback });
    const cleanup = [
      installStyles(),
      // Published before anything else can need it, and removed again on unload.
      installWorkspaceBridge(globalThis, bridge, feedback),
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
        onFeedback: feedback,
      }),
      // Registering the Engine's mapped folders as this instance's own workspaces belongs to the
      // host half, which runs on every boot whether or not a page is open. It is deliberately not
      // done here: two registrars for one registry is one rule too many.
      // The instance is the authority for its own sessions while the Engine runs, so a session the
      // operator archives or deletes here is written onto the same source session. Only changes seen
      // after this page's own first observation count — and the Engine's start overwrites the mapped
      // workspaces anyway, so nothing seen across a restart could be trusted as a user action.
      (() => {
        let previous = observeSessions(injected.sessions.list.getSnapshot());
        return injected.sessions.list.subscribe(() => {
          const current = observeSessions(injected.sessions.list.getSnapshot());
          const intents = sessionSyncIntents(previous, current);
          previous = current;
          if (intents.length === 0) return;
          void reportSessionChanges({
            engineReady: async () => (await actions.invoke({ operation: "status" })).ok,
            mapped: async sessionId => (await actions.invoke({ operation: "session-mapped", sessionId })).mapped === true,
            report: async intent => (await actions.invoke(intent.kind === "delete"
              ? { operation: "delete-session", sessionId: intent.sessionId }
              : { operation: "set-archived", sessionId: intent.sessionId, archived: current.get(intent.sessionId)?.archived === true })).message,
            onFeedback: feedback,
          }, intents);
        });
      })(),
    ];
    const contract = verifyUiContract(injected);
    if (!contract.compatible) {
      console.warn(`[dsh-session-maintenance] ${contract.reason}: ${contract.fingerprint}`);
    } else {
      cleanup.push(
        decorateSessionRows(injected),
      );
    }
    // A queue that survived the last page load is flushed once the Engine may be back.
    void joinQueue.flush().catch(error => { console.warn("[dsh-session-maintenance] 待办工作区加入未能交付", error); });
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
export * from "./workspace-join.js";
export * from "./workspace-bridge.js";
