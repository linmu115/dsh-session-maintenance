import type { ClientContext } from "./context.js";
import { createMaintenanceActions, describeInstanceWorkspace } from "./context.js";
import { installContextMenu } from "./context-menu.js";
import { openDashboard, registerOptionalSidebar } from "./dashboard-entry.js";
import { decorateSessionRows } from "./session-locator.js";
import { registerSettingsSection } from "./settings-actions.js";
import { installStyles } from "./styles.js";
import { verifyUiContract } from "./ui-contract.js";
import { BrowserPendingIntentStore, WorkspaceJoinQueue } from "./workspace-join.js";
import { installWorkspaceJoinEntry } from "./workspace-menu.js";

export const inject = ["sessions", "slots"] as const;

/**
 * The instance this client runs inside, when the host states it.
 *
 * The workspace entry needs an identity to key a deferred join. The Engine also
 * knows its own instance, so an unknown identity here does not block delivery —
 * it only means the pending intent is keyed by the workspace alone.
 */
export const CLIENT_INSTANCE_IDENTITY = { instanceId: "", profileId: "web" } as const;

export function apply(ctx: ClientContext): void {
  ctx.inject(inject, (injected) => {
    const actions = createMaintenanceActions();
    const feedback = (message: string) => { console.info(`[dsh-session-maintenance] ${message}`); };
    // The workspace-level entry has to work while the Engine is down, so the
    // pending intent is durable and the delivery attempt is what may fail.
    const joinQueue = new WorkspaceJoinQueue({ store: new BrowserPendingIntentStore(), report: feedback,
      deliver: async intent => {
        const result = await actions.invoke({ operation: "join-workspace", workspaceId: intent.workspaceId,
          workspaceName: intent.workspaceName, workspacePath: intent.workspacePath,
          ...(intent.instanceId.length === 0 ? {} : { instanceId: intent.instanceId }) });
        return result.message;
      } });
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
        onFeedback: feedback,
      }),
      installWorkspaceJoinEntry({ queue: joinQueue, instanceId: CLIENT_INSTANCE_IDENTITY.instanceId,
        profileId: CLIENT_INSTANCE_IDENTITY.profileId,
        describeWorkspace: (workspaceId: string) => describeInstanceWorkspace(injected.sessions.list.getSnapshot(), workspaceId),
        onFeedback: feedback }),
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
export * from "./workspace-join.js";
export * from "./workspace-menu.js";
