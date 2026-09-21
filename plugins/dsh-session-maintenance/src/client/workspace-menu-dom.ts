/**
 * Reading the workspace identity out of the context-menu host's own DOM.
 *
 * The installed menu plugin renders the workspace menu itself and marks each
 * item with the workspace's id; that attribute is the only identity a workspace
 * action can be given, because the public action registry is session-scoped.
 * Nothing here queries or drives the menu: it only recognises what the host has
 * already put on screen.
 */

export interface ScmMenuHost {
  readonly menuApiVersion?: 1;
  readonly registerActions?: (owner: string, actions: readonly unknown[]) => () => void;
}

/** Fired by the menu plugin once its bridge is available. */
export const SCM_MENU_READY_EVENT = "dsh-session-context-menu:ready";

/** The attributes the host uses to name the workspace an item belongs to. */
const WORKSPACE_ATTRIBUTES = ["data-dsh-workspace-id", "data-workspace-id", "data-dsh-maintenance-workspace-id"] as const;

export function workspaceIdFromElement(element: Element): string | undefined {
  for (const attribute of WORKSPACE_ATTRIBUTES) {
    const value = element.closest<HTMLElement>(`[${attribute}]`)?.getAttribute(attribute);
    if (value !== null && value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/** The workspace the clicked menu item belongs to, if the host named one. */
export function workspaceIdFromEvent(target: EventTarget | null): string | undefined {
  return target instanceof Element ? workspaceIdFromElement(target) : undefined;
}
