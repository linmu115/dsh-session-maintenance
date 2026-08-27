import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DshGatewayTokenService } from "@linmu/dsh-host-gateway";

import { assertRc2RuntimeSurface, createCoreGatewayHandler } from "../src/core-gateway.js";
import { apply } from "../src/index.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  })));
});

describe("DSH rc.2 Core host entry", () => {
  it("turns service drift into a fail-closed endpoint instead of a loader crash", async () => {
    expect(() => assertRc2RuntimeSurface({} as never)).toThrow(/sessions\.get/u);
    const secret = "s".repeat(43);
    const handler = createCoreGatewayHandler({
      runtime: {} as never,
      connection: { current: async () => ({ origin: "http://127.0.0.1:1", token: secret }) },
    });
    const server = createServer((request, response) => void handler(request, response));
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fixture server has no address");
    const scope = { transactionId: "probe", planHash: "probe", instanceId: "dsh-web", sessionId: "probe" };
    const token = new DshGatewayTokenService({ secret: Buffer.from(secret) }).issue(scope);
    const response = await fetch(`http://127.0.0.1:${address.port}/dsh-session-maintenance/core`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "probe", token, scope }),
    });
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("sessions.get");
  });

  it("unregisters both host endpoints when Cordis unloads the plugin", () => {
    const unregistrations = [vi.fn(), vi.fn()];
    const registrations: string[] = [];
    let dispose: (() => void) | undefined;
    const ctx = {
      webServer: {
        register: vi.fn((input: { readonly path: string }) => {
          registrations.push(input.path);
          return unregistrations[registrations.length - 1];
        }),
      },
      effect: (callback: () => () => void) => { dispose = callback(); },
    };
    expect(() => apply(ctx as never, { connectionId: "primary", dshInstanceId: "dsh-web", profileId: "web" })).not.toThrow();
    expect(registrations).toEqual(["/dsh-session-maintenance/api", "/dsh-session-maintenance/core"]);
    dispose?.();
    expect(unregistrations[0]).toHaveBeenCalledOnce();
    expect(unregistrations[1]).toHaveBeenCalledOnce();
  });
});
