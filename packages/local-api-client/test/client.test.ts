import { describe, expect, it } from "vitest";

import { MaintenanceClient } from "../src/index.js";

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
});
