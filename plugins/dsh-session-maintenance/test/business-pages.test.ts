import { afterEach, expect, it, vi } from "vitest";
import { MaintenanceBusinessPages } from "../src/business-pages.js";
import type { BusinessPageOwner, BusinessPageSnapshot } from "@linmu/dsh-session-contracts";
afterEach(() => vi.useRealTimers());
it("keeps tokens host-only, retries a lost receipt without executing the provider twice, and unregisters only its boot", async () => {
  vi.useFakeTimers();
  let owner: BusinessPageOwner | undefined, acknowledged = false, attempts = 0;
  const paths: string[] = [];
  const snapshot: BusinessPageSnapshot = { title: "Fixture", revision: 1, sections: [{ kind: "actions", id: "actions", title: "Actions", actions: [{ id: "bind", label: "Bind", expectedRevision: 2, fields: [] }] }] };
  const handler = vi.fn(async () => ({ message: "confirmed" }));
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = String(url).split("/").at(-1)!; paths.push(path);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer host-secret");
    const body = JSON.parse(String(init?.body));
    if (path === "register") owner = body.owner;
    if (path === "poll") return Response.json({ actions: acknowledged ? [] : [{ owner, operationId: "550e8400-e29b-41d4-a716-446655440001", actionId: "bind", expectedRevision: 2, input: {} }] });
    if (path === "ack") { if (++attempts === 1) return new Response("lost", { status: 503 }); acknowledged = true; }
    if (path === "unregister") expect(body).toEqual(owner);
    return Response.json({ ok: true });
  };
  const host = new MaintenanceBusinessPages({ current: async () => ({ origin: "http://127.0.0.1:12345", token: "host-secret" }) }, { instanceId: "trusted", profileId: "web" }, fetchImpl);
  const dispose = host.register({ namespace: "bridge", providerId: "binding", snapshot: async () => snapshot, handleAction: handler });
  await vi.advanceTimersByTimeAsync(1); expect(handler).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000); expect(handler).toHaveBeenCalledTimes(1); expect(acknowledged).toBe(true);
  expect(JSON.stringify(handler.mock.calls)).not.toContain("host-secret");
  expect(() => host.register({ namespace: "bridge", providerId: "binding", snapshot: async () => snapshot, handleAction: handler })).toThrow("already registered");
  dispose(); await host.dispose(); expect(paths).toContain("unregister");
  const count = paths.length; await vi.advanceTimersByTimeAsync(30_000); expect(paths.length).toBe(count);
});
