// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { BusinessPage } from "@linmu/dsh-session-contracts";
import { BusinessPages } from "../src/business-pages.js";
it("renders provider text as text, disables offline actions and confines execution to a named descriptor", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const page: BusinessPage = { owner: { instanceId: "instance", profileId: "web", namespace: "bridge", providerId: "binding", bootId: "550e8400-e29b-41d4-a716-446655440000" }, online: true, updatedAt: 1, expiresAt: 20000,
    snapshot: { title: "Binding", revision: 1, sections: [{ id: "text", title: "Status", kind: "summary", text: "<img src=x onerror=alert(1)>" }, { id: "actions", title: "Actions", kind: "actions", actions: [{ id: "bind", label: "绑定", expectedRevision: 4, fields: [] }] }] } };
  const enqueue = vi.fn(async request => ({ request, status: "completed" as const, message: "Companion confirmed", updatedAt: 2 }));
  const api = { listBusinessPages: async () => ({ pages: [page] }), enqueueBusinessPageAction: enqueue };
  try {
    await act(async () => root.render(<StrictMode><BusinessPages api={api} renderDirectory={() => null} /></StrictMode>));
    expect(container.querySelector("img")).toBeNull(); expect(container.textContent).toContain("<img");
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ actionId: "bind", expectedRevision: 4, owner: page.owner, input: {} });
    expect(container.textContent).toContain("Companion confirmed");
    page.online = false;
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "刷新")!.click());
    expect(container.querySelector("fieldset")!.disabled).toBe(true); expect(container.textContent).toContain("提供方离线");
  } finally { await act(async () => root.unmount()); container.remove(); }
});
it("reuses the original operation after a lost enqueue response", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const page: BusinessPage = { owner: { instanceId: "instance", profileId: "web", namespace: "bridge", providerId: "binding", bootId: "550e8400-e29b-41d4-a716-446655440000" }, online: true, updatedAt: 1, expiresAt: 20000,
    snapshot: { title: "Binding", revision: 1, sections: [{ id: "actions", title: "Actions", kind: "actions", actions: [{ id: "bind", label: "绑定", expectedRevision: 4, fields: [] }] }] } };
  const ledger = new Map<string, unknown>(); let sideEffects = 0;
  const enqueue = vi.fn(async request => {
    if (!ledger.has(request.operationId)) { sideEffects++; ledger.set(request.operationId, request); throw new Error("response lost"); }
    return { request, status: "completed" as const, message: "confirmed existing operation", updatedAt: 2 };
  });
  try {
    await act(async () => root.render(<BusinessPages api={{ listBusinessPages: async () => ({ pages: [page] }), enqueueBusinessPageAction: enqueue }} renderDirectory={() => null} />));
    const submit = () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await act(async () => { submit(); });
    expect(container.textContent).toContain("同一操作编号");
    await act(async () => { submit(); });
    expect(enqueue.mock.calls[0]![0]).toEqual(enqueue.mock.calls[1]![0]);
    expect(sideEffects).toBe(1); expect(container.textContent).toContain("confirmed existing operation");
  } finally { await act(async () => root.unmount()); container.remove(); }
});
