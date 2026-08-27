import type { ClientContext } from "./context.js";

export const SUPPORTED_CLIENT_CONTRACT = "dsh-web@0.1.1-rc.2|sessions.list:v1|treeitem:_sessionRow_|title:_title_";

function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}

export const SUPPORTED_CLIENT_FINGERPRINT = fingerprint(SUPPORTED_CLIENT_CONTRACT);

export interface UiContractResult {
  readonly compatible: boolean;
  readonly fingerprint: string;
  readonly reason?: "UI_CONTRACT_INCOMPATIBLE";
}

export function verifyUiContract(ctx: ClientContext, root: ParentNode = document): UiContractResult {
  const list = ctx.sessions?.list;
  if (typeof list?.getSnapshot !== "function" || typeof list.subscribe !== "function") {
    return { compatible: false, fingerprint: fingerprint("missing:sessions.list"), reason: "UI_CONTRACT_INCOMPATIBLE" };
  }
  const snapshot = list.getSnapshot();
  if (snapshot === null || typeof snapshot !== "object" || (snapshot.byId !== undefined && typeof snapshot.byId !== "object")) {
    return { compatible: false, fingerprint: fingerprint("invalid:sessions.snapshot"), reason: "UI_CONTRACT_INCOMPATIBLE" };
  }
  const rows = [...root.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const expectedRows = rows.filter((row) => String(row.className).includes("_sessionRow_"));
  const knownCount = Object.keys(snapshot.byId ?? {}).length;
  if (knownCount > 0 && rows.length > 0 && (expectedRows.length === 0 || expectedRows.some((row) => row.querySelector('[class*="_title_"]') === null))) {
    return { compatible: false, fingerprint: fingerprint("changed:session-row-or-title"), reason: "UI_CONTRACT_INCOMPATIBLE" };
  }
  return { compatible: true, fingerprint: SUPPORTED_CLIENT_FINGERPRINT };
}
