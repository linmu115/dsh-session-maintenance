import type { ClientContext } from "./context.js";

export interface MaintenanceLogicalLocation {
  readonly referenceType: "annotation" | "sticker" | "obsidian-reference";
  readonly logicalSessionId: string | null;
  readonly logicalAnchorId: string | null;
  readonly legacyNativeSessionId: string | null;
  readonly legacyNativeAnchorId: string | null;
}

export async function resolveMaintenanceLogicalLocation(input: {
  readonly endpoint: string;
  readonly authorization: string;
  readonly location: MaintenanceLogicalLocation;
  readonly fetchImpl?: typeof fetch;
}): Promise<{ readonly sessionId: string; readonly anchorId: string | null } | undefined> {
  const response = await (input.fetchImpl ?? fetch)(`${input.endpoint}/v1/references/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: input.authorization },
    body: JSON.stringify(input.location),
  });
  if (!response.ok) throw new Error(`Maintenance reference resolver returned HTTP ${response.status}`);
  const body = await response.json() as { readonly resolution?: { readonly status?: string; readonly nativeSessionId?: string | null; readonly nativeAnchorId?: string | null } };
  const resolution = body.resolution;
  return resolution?.status === "resolved" && typeof resolution.nativeSessionId === "string"
    ? { sessionId: resolution.nativeSessionId, anchorId: resolution.nativeAnchorId ?? null }
    : undefined;
}

export async function resolveMaintenanceLogicalLocationThroughProxy(
  location: MaintenanceLogicalLocation,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  readonly logicalSessionId: string | null;
  readonly logicalAnchorId: string | null;
  readonly sessionId: string;
  readonly anchorId: string | null;
} | undefined> {
  const response = await fetchImpl("/dsh-session-maintenance/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "reference:resolve", ...location }),
  });
  if (!response.ok) return undefined;
  const body = await response.json() as {
    readonly referenceResolution?: {
      readonly status?: string;
      readonly logicalSessionId?: string | null;
      readonly logicalAnchorId?: string | null;
      readonly nativeSessionId?: string | null;
      readonly nativeAnchorId?: string | null;
    };
  };
  const resolved = body.referenceResolution;
  return resolved?.status === "resolved" && typeof resolved.nativeSessionId === "string"
    ? {
        logicalSessionId: resolved.logicalSessionId ?? null,
        logicalAnchorId: resolved.logicalAnchorId ?? null,
        sessionId: resolved.nativeSessionId,
        anchorId: resolved.nativeAnchorId ?? null,
      }
    : undefined;
}

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
