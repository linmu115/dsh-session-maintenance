// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardApp, DashboardOffline, type DashboardApi } from "../src/app.js";

let container: HTMLDivElement;
let root: Root;
const preferenceKey = "dsh-maintenance.appearance";
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.removeItem(preferenceKey);
  delete document.documentElement.dataset.dsmAppearance;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks();
  localStorage.removeItem(preferenceKey); delete document.documentElement.dataset.dsmAppearance;
});
function appearance() {
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="外观"]');
  expect(select, "The appearance choice must remain available in the app header").not.toBeNull();
  return select!;
}
async function choose(value: string) {
  await act(async () => { const select = appearance(); select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
}

describe("workbench appearance", () => {
  it("defaults to light and changes appearance without restarting the workspace read", async () => {
    const listCanonicalWorkspaces = vi.fn(async () => ({ schemaVersion: 1, workspaces: [], unclassified: [] }));
    await act(async () => root.render(<DashboardApp api={{ listCanonicalWorkspaces } as unknown as DashboardApi} />));
    expect(appearance().value).toBe("light");
    expect(document.documentElement.dataset.dsmAppearance).toBe("light");
    await choose("dark");
    expect(document.documentElement.dataset.dsmAppearance).toBe("dark");
    expect(localStorage.getItem(preferenceKey)).toBe("dark");
    expect(listCanonicalWorkspaces).toHaveBeenCalledTimes(1);
    expect(container.querySelector('nav [aria-current="page"]')?.textContent).toBe("会话");
  });

  it("restores the same preference after remount and on the offline page", async () => {
    localStorage.setItem(preferenceKey, "dark");
    await act(async () => root.render(<DashboardOffline />));
    expect(appearance().value).toBe("dark");
    await choose("system");
    expect(localStorage.getItem(preferenceKey)).toBe("system");
    await act(async () => root.unmount()); root = createRoot(container);
    await act(async () => root.render(<DashboardOffline />));
    expect(appearance().value).toBe("system");
    expect(document.documentElement.dataset.dsmAppearance).toBe("system");
    expect(container.textContent).toContain("请重新打开看板");
  });

  it("keeps appearance usable when browser preference storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    await act(async () => root.render(<DashboardOffline />));
    expect(appearance().value).toBe("light");
    await choose("dark");
    expect(appearance().value).toBe("dark");
    expect(document.documentElement.dataset.dsmAppearance).toBe("dark");
  });

  it("uses a readable default for an unknown saved preference", async () => {
    localStorage.setItem(preferenceKey, "unsupported-theme");
    await act(async () => root.render(<DashboardOffline />));
    expect(appearance().value).toBe("light");
  });
});
