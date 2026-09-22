import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { InstanceWorkspaceConfiguration, InstanceWorkspaceEffectiveScope, InstanceSessionAvailability } from "@linmu/dsh-session-contracts";
import { InstanceWorkspaceService, type InstanceWorkspacePorts } from "../src/instance-workspace-service.js";
import { routeInstanceWorkspaceRequest } from "../src/http/instance-workspace-routes.js";

function fixture() {
  let configuration: InstanceWorkspaceConfiguration = { policy: { schemaVersion: 1, instanceId: "i-one", revision: 1, selection: { kind: "all" }, updatedAt: "2026-09-18T00:00:00Z" },
    activeScopes: [{ profileId: "web", runId: "run-one", policyRevision: 1, selection: { kind: "all" } }], workspaces: [], pendingActivation: false };
  const writePolicy = vi.fn(async (_instanceId, update) => { configuration = { ...configuration, policy: { ...configuration.policy, revision: 2, selection: update.selection } }; });
  const ports: InstanceWorkspacePorts = {
    listInstances: async () => ({ instances: [{ instanceId: "i-one", name: "Synthetic DSH" }] }),
    readConfiguration: async () => configuration, writePolicy,
    readEffectiveScope: async () => ({ schemaVersion: 1, instanceId: "i-one", profileId: "web", policyRevision: 1, selection: { kind: "all" }, workspaces: [], includeUnassigned: true }),
    readSessionAvailability: async (_instance, logicalSessionId) => ({ schemaVersion: 1, instanceId: "i-one", profileId: "web", logicalSessionId: logicalSessionId as never, workspaceId: null, policyRevision: 1, status: "offline", nativeSessionId: null }),
  };
  return { ports, service: new InstanceWorkspaceService(ports), writePolicy };
}
describe("instance workspace API service", () => {
  it("saves intent without changing active scopes and rejects an unregistered target before writing", async () => {
    const { service, writePolicy } = fixture();
    const update = { expectedRevision: 1, selection: { kind: "ids" as const, workspaceIds: [], includeUnassigned: false } };
    const saved = await service.save("i-one", update);
    expect(saved.policy.selection).toEqual(update.selection); expect(saved.pendingActivation).toBe(true);
    expect(saved.activeScopes[0]).toMatchObject({ policyRevision: 1, selection: { kind: "all" } });
    await expect(service.save("codex-source", update)).rejects.toMatchObject({ status: 404 });
    expect(writePolicy).toHaveBeenCalledTimes(1);
  });
  it("preserves CAS conflict status and rejects provider responses for another instance/profile/session", async () => {
    const { service, ports, writePolicy } = fixture();
    writePolicy.mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "INSTANCE_WORKSPACE_POLICY_CONFLICT" }));
    await expect(service.save("i-one", { expectedRevision: 0, selection: { kind: "all" } })).rejects.toMatchObject({ status: 409, code: "INSTANCE_WORKSPACE_POLICY_CONFLICT" });
    const scope = await ports.readEffectiveScope("i-one", "web");
    ports.readEffectiveScope = async () => ({ ...scope, profileId: "another" });
    await expect(service.effectiveScope("i-one", "web")).rejects.toMatchObject({ status: 502 });
    const availability = await ports.readSessionAvailability("i-one", "logical", "web");
    ports.readSessionAvailability = async () => ({ ...availability, logicalSessionId: "another" as never });
    await expect(service.sessionAvailability("i-one", "logical", "web")).rejects.toMatchObject({ status: 502 });
  });
  it("aligns every registered instance at start, and one instance's failure never stops another", async () => {
    const { service, ports } = fixture();
    const synced: string[] = [];
    ports.registeredInstances = async () => ["i-one", "i-two", "i-one"];
    ports.syncToInstance = async instanceId => {
      synced.push(instanceId);
      if (instanceId === "i-one") throw new Error("实例目录不可写");
      return { written: 3, unchanged: 1, skippedOutOfScope: 5, failures: [] };
    };
    const aligned = await service.alignRegisteredInstances();
    // The duplicate registration is aligned once; the failing instance is reported, not thrown.
    expect(synced).toEqual(["i-one", "i-two"]);
    expect(aligned.map(item => item.instanceId)).toEqual(["i-one", "i-two"]);
    expect(aligned[0]!.summary.failures).toEqual(["实例目录不可写"]);
    expect(aligned[1]!.summary).toMatchObject({ written: 3, skippedOutOfScope: 5 });
  });
  it("does nothing at start when this Engine has no registered instance to align", async () => {
    const { service, ports } = fixture();
    let called = 0;
    ports.syncToInstance = async () => { called += 1; return { written: 0, unchanged: 0, skippedOutOfScope: 0, failures: [] }; };
    expect(await service.alignRegisteredInstances()).toEqual([]);
    expect(called).toBe(0);
  });
  it("routes the four bounded resources and leaves unrelated paths/methods to the common server", async () => {
    const { service } = fixture();
    const call = async (path: string, method = "GET", body?: unknown) => {
      const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method }) as IncomingMessage;
      let output = ""; const response = { statusCode: 0, setHeader: vi.fn(), end(value: string) { output = value; } } as unknown as ServerResponse;
      const routed = await routeInstanceWorkspaceRequest(request, response, new URL(path, "http://127.0.0.1"), { instanceWorkspace: service });
      return { routed, body: output ? JSON.parse(output) : undefined };
    };
    expect((await call("/v1/instances/workspace-sync")).body.directory.instances[0].instanceId).toBe("i-one");
    expect((await call("/v1/instances/i-one/workspace-sync", "PATCH", { expectedRevision: 1, selection: { kind: "ids", workspaceIds: [], includeUnassigned: true } })).body.configuration.pendingActivation).toBe(true);
    expect(((await call("/v1/instances/i-one/workspace-scope?profileId=web")).body.scope as InstanceWorkspaceEffectiveScope).policyRevision).toBe(1);
    expect(((await call("/v1/instances/i-one/sessions/logical/availability?profileId=web")).body.availability as InstanceSessionAvailability).status).toBe("offline");
    expect((await call("/v1/instances/i-one/workspace-scope", "PATCH", {})).routed).toBe(false);
    expect((await call("/v1/workspace-sync")).routed).toBe(false);
  });
});
