import { describe, expect, it } from "vitest";

import { DashboardClient, MaintenanceClient } from "../src/index.js";

describe("MaintenanceClient", () => {
  it("validates responses and redacts its token from errors", async () => {
    const token = "secret-token-canary";
    const client = new MaintenanceClient({
      origin: "http://127.0.0.1:1",
      token,
      fetchImpl: async () => new Response(JSON.stringify({ error: { code: "BAD", message: token } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    });
    await expect(client.listSessions()).rejects.not.toThrow(token);
    await expect(client.listSessions()).rejects.toThrow("[REDACTED]");
  });

  it("keeps the Engine capability out of the cookie-authenticated Dashboard client", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const receivers: unknown[] = [];
    const fetchImpl: typeof fetch = async function (this: unknown, input, init) {
      receivers.push(this);
      if (this !== undefined) throw new TypeError("Illegal invocation");
      const url = String(input);
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.endsWith("/v1/ui/session")) {
        return new Response(JSON.stringify({
          session: { csrfToken: "csrf-session-fixture", expiresAt: "2026-08-27T00:15:00.000Z", initialLogicalSessionId: "logical-fixture" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        overview: { sessions: 0, conflicts: 0, unmapped: 0, unresolvedTransactions: 0, instances: [] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = await DashboardClient.connect({ origin: "http://127.0.0.1:43123", fetchImpl });
    expect(client.initialLogicalSessionId).toBe("logical-fixture");
    await client.overview();
    expect(calls).toHaveLength(2);
    expect(receivers).toEqual([undefined, undefined]);
    expect(calls[0]?.init?.credentials).toBe("same-origin");
    const headers = new Headers(calls[1]?.init?.headers);
    expect(calls[1]?.init?.credentials).toBe("same-origin");
    expect(headers.get("x-dsh-csrf")).toBe("csrf-session-fixture");
    expect(headers.has("authorization")).toBe(false);
  });
});
