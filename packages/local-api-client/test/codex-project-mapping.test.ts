import { describe, expect, it, vi } from "vitest";
import type { CodexProjectMappingConfiguration } from "@linmu/dsh-session-contracts";
import { DashboardClient, MaintenanceClient } from "../src/index.js";
const configuration: CodexProjectMappingConfiguration = {
  policy: { revision: 2, activeRevision: 1, configured: true, activeConfigured: false, projectKeys: [], activeProjectKeys: [], includeFutureSessions: true },
  projects: [{ key: "synthetic/project", instanceId: "synthetic", projectId: "project", name: "Synthetic", roots: [], sessionCount: 0, kind: "mixed", eligible: true, issues: [] }],
  issues: [], pendingActivation: true, observer: { state: "stopped", lastSyncAt: null, lastError: null },
};

describe("Codex project mapping client", () => {
  it("reads and patches validated project policy with cookie and CSRF authentication", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = await DashboardClient.connect({ origin: "http://127.0.0.1:43123", fetchImpl: async (input, init) => {
      calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
      return Response.json(String(input).endsWith("/v1/ui/session") ? { session: { csrfToken: "synthetic-csrf", expiresAt: "2026-09-06T12:15:00.000Z" } } : { configuration });
    } });
    const controller = new AbortController();
    expect(await client.getCodexProjectMapping(controller.signal)).toEqual(configuration);
    expect(await client.saveCodexProjectMapping({ revision: 2, projectKeys: [] }, controller.signal)).toEqual(configuration);
    expect(calls[1]?.url).toBe("http://127.0.0.1:43123/v1/codex-project-mapping");
    expect(calls[2]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ revision: 2, projectKeys: [] });
    for (const call of calls.slice(1)) {
      expect(call.init?.credentials).toBe("same-origin"); expect(call.init?.signal).toBe(controller.signal);
      expect(new Headers(call.init?.headers).get("x-dsh-csrf")).toBe("synthetic-csrf");
      expect(new Headers(call.init?.headers).has("authorization")).toBe(false);
    }
  });

  it("rejects invalid updates before transport and validates responses", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ configuration: { ...configuration, policy: { ...configuration.policy, includeFutureSessions: false } } }));
    const client = new MaintenanceClient({ origin: "http://127.0.0.1:1", token: "synthetic", fetchImpl });
    await expect(client.saveCodexProjectMapping({ revision: -1, projectKeys: [] })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(client.getCodexProjectMapping()).rejects.toThrow();
  });

  it("retains API conflict codes for an actionable UI response", async () => {
    const client = new MaintenanceClient({ origin: "http://127.0.0.1:1", token: "synthetic", fetchImpl: async () => Response.json({ error: { code: "REVISION_CONFLICT", message: "saved elsewhere" } }, { status: 409 }) });
    await expect(client.saveCodexProjectMapping({ revision: 1, projectKeys: ["synthetic/project"] })).rejects.toThrow("REVISION_CONFLICT");
  });
});
