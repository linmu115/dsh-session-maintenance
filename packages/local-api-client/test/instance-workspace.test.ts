import { expect, it } from "vitest";
import { MaintenanceClient } from "../src/index.js";
it("uses bounded instance endpoints and preserves structured policy conflict status", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = new MaintenanceClient({ origin: "http://127.0.0.1:12345", token: "fixture-token", fetchImpl: async (url, init) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    return String(url).endsWith("/v1/instances/workspace-sync") ? Response.json({ directory: { instances: [{ instanceId: "one", name: "One" }] } })
      : Response.json({ error: { code: "INSTANCE_WORKSPACE_POLICY_CONFLICT", message: "stale fixture" } }, { status: 409 });
  } });
  expect((await client.listInstanceWorkspaceInstances()).instances[0]?.instanceId).toBe("one");
  const controller = new AbortController();
  await expect(client.saveInstanceWorkspaceSync("one", { expectedRevision: 1, selection: { kind: "ids", workspaceIds: [], includeUnassigned: false } }, controller.signal)).rejects.toMatchObject({ status: 409, code: "INSTANCE_WORKSPACE_POLICY_CONFLICT" });
  expect(calls[1]?.url).toBe("http://127.0.0.1:12345/v1/instances/one/workspace-sync");
  expect(calls[1]?.init).toMatchObject({ method: "PATCH", signal: controller.signal });
});
