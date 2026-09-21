import { SCM_MENU_READY_EVENT, workspaceIdFromEvent, type ScmMenuHost } from "./workspace-menu-dom.js";
import type { WorkspaceJoinOutcome, WorkspaceJoinQueue } from "./workspace-join.js";

/**
 * The workspace-level menu entry.
 *
 * SCM's public action registry is session-scoped — its target has a session id,
 * not a workspace — and the installed menu plugin owns the workspace menu as its
 * own DOM. So this entry joins that DOM the way the existing session decorator
 * already does, and stays read-only about it: it adds one item, reads the
 * workspace identity off the host's own data attributes, and never drives the
 * menu itself. Everything the item does is the join queue's business.
 */

export const WORKSPACE_MENU_ITEM_ID = "workspace-join";
export const WORKSPACE_MENU_LABEL = "将当前工作区加入 sessionmaintenance";

/** The item is added once per open menu, and marked so a mutation storm cannot duplicate it. */
function installItem(menu: HTMLElement): void {
  if (menu.querySelector(`[data-dsh-maintenance-workspace-join]`) !== null) return;
  const template = menu.querySelector<HTMLElement>('[role="menuitem"]');
  const item = document.createElement(template?.tagName.toLowerCase() === "li" ? "li" : "button");
  item.setAttribute("role", "menuitem");
  item.setAttribute("tabindex", "-1");
  item.setAttribute("data-dsh-maintenance-workspace-join", WORKSPACE_MENU_ITEM_ID);
  item.textContent = WORKSPACE_MENU_LABEL;
  if (template !== null) item.className = template.className;
  menu.append(item);
}

export interface WorkspaceMenuEntryInput {
  readonly queue: WorkspaceJoinQueue;
  readonly instanceId: string;
  readonly profileId: string;
  /** The workspace's name as the instance shows it, and its directory if known. */
  readonly describeWorkspace: (workspaceId: string) => { readonly name: string; readonly path: string } | undefined;
  readonly onFeedback: (message: string) => void;
  /** Where the host renders a workspace menu; injectable so the entry is testable. */
  readonly workspaceMenuSelector?: string;
}

const DEFAULT_WORKSPACE_MENU_SELECTOR = '[role="menu"][data-dsh-workspace-id], [role="menu"][data-workspace-id]';

/**
 * Watch for the workspace menu, add the entry, and handle its click.
 *
 * The click is handled by delegation on the document, so it works no matter when
 * the host re-created the menu, and the outcome is reported as a status message:
 * a deferred join is a normal outcome the user is told about, never an error
 * thrown into the host's menu.
 */
export function installWorkspaceJoinEntry(input: WorkspaceMenuEntryInput): () => void {
  const selector = input.workspaceMenuSelector ?? DEFAULT_WORKSPACE_MENU_SELECTOR;
  let disposed = false;

  const decorate = () => {
    if (disposed) return;
    for (const menu of document.querySelectorAll<HTMLElement>(selector)) installItem(menu);
  };

  const onClick = (event: Event) => {
    if (disposed) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const item = target.closest<HTMLElement>("[data-dsh-maintenance-workspace-join]");
    if (item === null) return;
    const workspaceId = workspaceIdFromEvent(item);
    if (workspaceId === undefined) {
      input.onFeedback("无法确定这个工作区；请在展开的工作区菜单上重试。");
      return;
    }
    const described = input.describeWorkspace(workspaceId);
    if (described === undefined) {
      input.onFeedback("这个工作区暂时读不到名称与目录，未加入；请稍后重试。");
      return;
    }
    // The click is consumed here: the host must not also run its own action.
    event.preventDefault();
    event.stopPropagation();
    void input.queue.requestJoin({ instanceId: input.instanceId, profileId: input.profileId,
      workspaceId, workspaceName: described.name, workspacePath: described.path })
      .then((outcome: WorkspaceJoinOutcome) => { if (!disposed) input.onFeedback(outcome.message); },
        (error: unknown) => { if (!disposed) input.onFeedback(`加入工作区失败：${error instanceof Error ? error.message : String(error)}`); });
  };

  decorate();
  const observer = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(decorate);
  if (observer !== undefined) observer.observe(document, { childList: true, subtree: true });
  const scm = typeof window === "undefined" ? undefined : (window as unknown as { __dshSessionContextMenu?: ScmMenuHost }).__dshSessionContextMenu;
  document.addEventListener("click", onClick, true);
  window.addEventListener(SCM_MENU_READY_EVENT, decorate);

  return () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener("click", onClick, true);
    window.removeEventListener(SCM_MENU_READY_EVENT, decorate);
    observer?.disconnect();
    for (const item of document.querySelectorAll("[data-dsh-maintenance-workspace-join]")) item.remove();
    void scm;
  };
}
