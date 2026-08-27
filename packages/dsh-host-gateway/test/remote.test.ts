import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  LockedRc2CoreExtension,
  type CoreHostMaterializationProbe,
} from "../../dsh-core-extension/src/index.js";
import { createDshCoreFixtureHost } from "../../test-support/src/index.js";
import {
  DshGatewayTokenService,
  DshHostGateway,
  RemoteDshHostGateway,
  createDshGatewayHttpHandler,
  type DshGatewayScope,
} from "../src/index.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  })));
});

async function listen(handler: ReturnType<typeof createDshGatewayHttpHandler>): Promise<string> {
  const server = createServer((request, response) => void handler(request, response));
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

function compatibleMaterialization(): Promise<CoreHostMaterializationProbe> {
  return Promise.resolve({
    status: "compatible",
    sourceHash: "sha256:fixture-source",
    artifactHash: "sha256:fixture-artifact",
    issues: [],
  });
}

describe("remote DSH Core gateway", () => {
  it("performs a scoped mutation and restore while following Engine token and port rotation", async () => {
    const host = createDshCoreFixtureHost();
    const extension = new LockedRc2CoreExtension(host);
    let secret = Buffer.alloc(32, 1);
    const tokenServices = new Map<string, DshGatewayTokenService>();
    const handler = () => createDshGatewayHttpHandler({
      createGateway: async () => {
        const key = secret.toString("hex");
        let tokens = tokenServices.get(key);
        if (tokens === undefined) {
          tokens = new DshGatewayTokenService({ secret });
          tokenServices.set(key, tokens);
        }
        return new DshHostGateway({
          extensions: new Map([["dsh-fixture", extension]]),
          tokens,
          materializationProbe: compatibleMaterialization,
        });
      },
    });
    let origin = await listen(handler());
    const remote = new RemoteDshHostGateway({
      connections: { current: async () => ({ origin, secret }) },
    });
    expect((await remote.probeInstance("dsh-fixture")).status).toBe("compatible");

    const scope: DshGatewayScope = {
      transactionId: "tx-remote",
      planHash: "plan-remote",
      instanceId: "dsh-fixture",
      sessionId: "dsh-session-1",
    };
    const client = remote.client(scope);
    const before = await client.capture();
    const changed = await client.apply({ snapshot: before, events: [], archived: true });
    expect(changed.archived).toBe(true);

    secret = Buffer.alloc(32, 2);
    origin = await listen(handler());
    expect((await remote.probeInstance("dsh-fixture")).status).toBe("compatible");
    expect((await client.restore(before)).digest).toBe(before.before.digest);
  });

  it("rejects a replayed token and a scope-tampered envelope", async () => {
    const secret = Buffer.alloc(32, 3);
    const tokens = new DshGatewayTokenService({ secret });
    const gateway = new DshHostGateway({
      extensions: new Map([["dsh-fixture", new LockedRc2CoreExtension(createDshCoreFixtureHost())]]),
      tokens,
      materializationProbe: compatibleMaterialization,
    });
    const origin = await listen(createDshGatewayHttpHandler({ createGateway: async () => gateway }));
    const scope: DshGatewayScope = {
      transactionId: "tx-auth",
      planHash: "plan-auth",
      instanceId: "dsh-fixture",
      sessionId: "dsh-session-1",
    };
    const token = tokens.issue(scope);
    const body = JSON.stringify({ kind: "invoke", token, scope, request: { operation: "capture" } });
    expect((await fetch(`${origin}/dsh-session-maintenance/core`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })).status).toBe(200);
    expect((await fetch(`${origin}/dsh-session-maintenance/core`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })).status).toBe(409);

    const drifted = { ...scope, sessionId: "dsh-session-2" };
    const driftResponse = await fetch(`${origin}/dsh-session-maintenance/core`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "invoke", token: tokens.issue(scope), scope: drifted, request: { operation: "capture" } }),
    });
    expect(driftResponse.status).toBe(409);
    expect(await driftResponse.text()).not.toContain(secret.toString("hex"));
  });

  it("fails closed before mutation when the materialized Core host drifts", async () => {
    const host = createDshCoreFixtureHost();
    const secret = Buffer.alloc(32, 4);
    const gateway = new DshHostGateway({
      extensions: new Map([["dsh-fixture", new LockedRc2CoreExtension(host)]]),
      tokens: new DshGatewayTokenService({ secret }),
      materializationProbe: async () => ({
        status: "unsupported",
        sourceHash: "sha256:expected",
        artifactHash: "sha256:drifted",
        issues: [{ code: "ADAPTER_INCOMPATIBLE", message: "fixture drift" }],
      }),
    });
    const origin = await listen(createDshGatewayHttpHandler({ createGateway: async () => gateway }));
    const remote = new RemoteDshHostGateway({ connections: { current: async () => ({ origin, secret }) } });
    expect((await remote.probeInstance("dsh-fixture")).status).toBe("unsupported");
    const client = remote.client({
      transactionId: "tx-drift",
      planHash: "plan-drift",
      instanceId: "dsh-fixture",
      sessionId: "dsh-session-1",
    });
    await expect(client.capture()).rejects.toMatchObject({ code: "ADAPTER_INCOMPATIBLE" });
    expect(host.writes).toEqual([]);
  });
});
