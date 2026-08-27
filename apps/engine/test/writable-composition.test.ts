import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  DshGatewayTokenService,
  DshHostGateway,
  createDshGatewayHttpHandler,
} from "@linmu/dsh-host-gateway";
import { LockedRc2CoreExtension } from "../../../packages/dsh-core-extension/src/index.js";
import { createDshCoreFixtureHost } from "../../../packages/test-support/src/index.js";

import { createDshWritableComposition, probeAndAddInstance } from "../src/composition-root.js";
import { createFixtureSystem } from "./helpers.js";

const servers: Server[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  })));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("writable Engine composition", () => {
  it("attaches the locked remote rc.2 writer only for an explicitly registered loopback target", async () => {
    const fixture = await createFixtureSystem("engine-writable-composition");
    cleanups.push(fixture.cleanup);
    const options = { stateRoot: fixture.stateRoot, fixturePolicy: fixture.fixturePolicy };
    await probeAndAddInstance(options, {
      id: "dsh-fixture",
      platform: "dsh",
      displayName: "DSH fixture",
      root: fixture.dshHome,
      platformVersion: "0.1.1-rc.2",
    });
    const secret = "g".repeat(43);
    await writeFile(
      `${fixture.stateRoot}\\connection.json`,
      JSON.stringify({ schemaVersion: 1, host: "127.0.0.1", port: 41111, token: secret }),
    );
    const gateway = new DshHostGateway({
      extensions: new Map([["dsh-fixture", new LockedRc2CoreExtension(createDshCoreFixtureHost())]]),
      tokens: new DshGatewayTokenService({ secret: Buffer.from(secret) }),
      materializationProbe: async () => ({ status: "compatible", sourceHash: "sha256:source", artifactHash: "sha256:artifact", issues: [] }),
    });
    const handler = createDshGatewayHttpHandler({ createGateway: async () => gateway });
    const server = createServer((request, response) => void handler(request, response));
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fixture server has no address");
    const engine = await createDshWritableComposition({
      ...options,
      dshGatewayTargets: [{ instanceId: "dsh-fixture", origin: `http://127.0.0.1:${address.port}` }],
    });
    try {
      const diagnostics = await engine.listAdapterDiagnostics();
      expect(diagnostics).toEqual([
        expect.objectContaining({
          writeStatus: "compatible",
          writeContract: expect.objectContaining({ adapter: "dsh-write-core", platformVersion: "0.1.1-rc.2" }),
        }),
      ]);
    } finally {
      engine.close();
    }
  });
});
