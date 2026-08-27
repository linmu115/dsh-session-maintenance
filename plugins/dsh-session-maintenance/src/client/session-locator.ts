import type { ClientContext } from "./context.js";

const ROW_SELECTOR = '[role="treeitem"][class*="_sessionRow_"]';
const TITLE_SELECTOR = '[class*="_title_"]';

export function decorateSessionRows(ctx: ClientContext, root: ParentNode = document): () => void {
  const decorate = () => {
    const byId = ctx.sessions.list.getSnapshot().byId ?? {};
    const titleToIds = new Map<string, string[]>();
    for (const [id, item] of Object.entries(byId)) {
      const title = item?.title?.trim();
      if (title === undefined || title.length === 0) continue;
      titleToIds.set(title, [...(titleToIds.get(title) ?? []), id]);
    }
    for (const row of root.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      delete row.dataset.dshMaintenanceSessionId;
      const title = row.querySelector<HTMLElement>(TITLE_SELECTOR)?.textContent?.trim();
      if (title === undefined) continue;
      const ids = titleToIds.get(title);
      if (ids?.length === 1) row.dataset.dshMaintenanceSessionId = ids[0]!;
    }
  };
  decorate();
  const unsubscribe = ctx.sessions.list.subscribe(decorate);
  const observer = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(decorate);
  if (observer !== undefined && root instanceof Node) observer.observe(root, { childList: true, subtree: true });
  return () => {
    unsubscribe();
    observer?.disconnect();
    for (const row of root.querySelectorAll<HTMLElement>(ROW_SELECTOR)) delete row.dataset.dshMaintenanceSessionId;
  };
}

export function sessionIdFromEvent(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined;
  const value = target.closest<HTMLElement>("[data-dsh-maintenance-session-id]")?.dataset.dshMaintenanceSessionId;
  return value === undefined || value.length === 0 ? undefined : value;
}
