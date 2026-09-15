import { afterEach, expect, it, vi } from "vitest";
import { MaintenanceSessionContext } from "../src/session-context.js";

afterEach(() => vi.unstubAllGlobals());
it("checks revoked references in the current target without flushing, recapturing, or treating an unknown identity as removed", async () => {
  const requests: { url: string; body: any }[] = [], flush = vi.fn();
  vi.stubGlobal("fetch", async (url: string, input: RequestInit) => {
    const body = JSON.parse(String(input.body)); requests.push({ url, body });
    return body.referenceId === "known" ? new Response(JSON.stringify({ referenceId: "known", state: "revoked" }))
      : new Response(JSON.stringify({ error: { message: "引用对象不存在" } }), { status: 404 });
  });
  const host = new MaintenanceSessionContext({ current: async () => ({ origin: "http://127.0.0.1:41781", token: "synthetic" }) }, "bound-run", flush);
  expect(await host.status("target", "known")).toEqual({ referenceId: "known", state: "revoked" });
  expect(requests[0]).toEqual({ url: "http://127.0.0.1:41781/v1/session-context/status",
    body: { runId: "bound-run", targetNativeSessionId: "target", referenceId: "known" } });
  await expect(host.status("target", "missing")).rejects.toThrow("引用对象不存在");
  expect(flush).not.toHaveBeenCalled();
});
