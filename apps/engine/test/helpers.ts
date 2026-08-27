import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import type { CodexContinuationPort } from "@linmu/dsh-session-contracts";

import {
  assertFixtureSandbox,
  createFixtureSandbox,
  writeCodexFixtureHome,
  writeDshFixtureHome,
} from "../../../packages/test-support/src/index.js";
import { runCli as executeCli } from "../src/cli.js";
import { createReadOnlyComposition, probeAndAddInstance } from "../src/composition-root.js";
import { addCodexTarget } from "../src/config.js";
import { startMaintenanceServer } from "../src/http/server.js";

export async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        hash.update(relative(root, path).replaceAll("\\", "/"));
        hash.update("\0");
        hash.update(await readFile(path));
      }
    }
  };
  await visit(root);
  return hash.digest("hex");
}

export async function createFixtureSystem(name: string) {
  const sandbox = await createFixtureSandbox(name);
  await writeCodexFixtureHome(sandbox.codexHome);
  await writeDshFixtureHome(sandbox.dshHome);
  const stateRoot = join(sandbox.root, "state");
  await mkdir(stateRoot);
  return {
    ...sandbox,
    stateRoot,
    platformRoot: sandbox.codexHome,
    fixturePolicy: assertFixtureSandbox,
  };
}

export async function runCli(argv: readonly string[], fixture: Awaited<ReturnType<typeof createFixtureSystem>>) {
  let stdout = "";
  let stderr = "";
  const exitCode = await executeCli(argv, {
    fixturePolicy: fixture.fixturePolicy,
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  });
  return { exitCode, stdout, stderr };
}

export async function createEngineFixture(name: string, input: {
  readonly continuationAdapter?: CodexContinuationPort;
  readonly withContinuationTarget?: boolean;
} = {}) {
  const fixture = await createFixtureSystem(name);
  const options = { stateRoot: fixture.stateRoot, fixturePolicy: fixture.fixturePolicy };
  await probeAndAddInstance(options, {
    id: "codex-fixture",
    platform: "codex",
    displayName: "Codex fixture",
    root: fixture.codexHome,
    platformVersion: "0.146.0",
  });
  if (input.withContinuationTarget === true) {
    await probeAndAddInstance(options, {
      id: "dsh-fixture",
      platform: "dsh",
      displayName: "DSH fixture",
      root: fixture.dshHome,
      platformVersion: "0.1.1-rc.2",
    });
    await addCodexTarget(fixture.stateRoot, {
      id: "codex-default",
      codexInstanceId: "codex-fixture",
      cwd: fixture.root,
      runtimeWorkspaceRoots: [fixture.root],
      contextWindowTokens: 120_000,
      inputBudgetRatio: 0.8,
    });
  }
  const engine = await createReadOnlyComposition({
    ...options,
    ...(input.continuationAdapter === undefined ? {} : { continuationAdapter: input.continuationAdapter }),
  });
  const servers: Array<{ close: () => Promise<void> }> = [];
  return {
    ...fixture,
    engine,
    startServer: async (input: { readonly host?: string; readonly port?: number; readonly dashboardRoot?: string } = {}) => {
      const server = await startMaintenanceServer({ engine, stateRoot: fixture.stateRoot, ...input, skipAcl: true });
      servers.push(server);
      return server;
    },
    stop: async () => {
      await Promise.all(servers.splice(0).map((server) => server.close()));
      engine.close();
    },
    cleanupAll: async () => {
      await Promise.all(servers.splice(0).map((server) => server.close()));
      engine.close();
      await fixture.cleanup();
    },
  };
}
