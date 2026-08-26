import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { CodexReadAdapter } from "../../../packages/adapter-codex-read/src/index.js";
import { DshReadAdapter } from "../../../packages/adapter-dsh/src/index.js";
import { DiscoveryService } from "../../../packages/session-domain/src/index.js";
import {
  SqliteSessionRepository,
  ZstdContentObjectStore,
  openMaintenanceDatabase,
} from "../../../packages/session-store/src/index.js";
import {
  assertFixtureSandbox,
  createFixtureSandbox,
  writeCodexFixtureHome,
  writeDshFixtureHome,
} from "../../../packages/test-support/src/index.js";

export async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
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

export async function createReadOnlyTestSystem() {
  const sandbox = await createFixtureSandbox("read-only-system");
  await writeCodexFixtureHome(sandbox.codexHome);
  await writeDshFixtureHome(sandbox.dshHome);
  const stateRoot = join(sandbox.root, "maintenance-state");
  await mkdir(stateRoot);
  const objectStore = new ZstdContentObjectStore(stateRoot);
  const repository = new SqliteSessionRepository(
    openMaintenanceDatabase(join(stateRoot, "metadata.sqlite")),
    objectStore,
  );
  const instances = [
    {
      id: "codex-fixture",
      platform: "codex" as const,
      displayName: "Codex fixture",
      root: sandbox.codexHome,
      platformVersion: "0.146.0",
    },
    {
      id: "dsh-fixture",
      platform: "dsh" as const,
      displayName: "DSH fixture",
      root: sandbox.dshHome,
      platformVersion: "0.1.1-rc.2",
    },
  ];
  const discovery = new DiscoveryService({
    instances,
    adapters: [
      new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox }),
      new DshReadAdapter({ fixtureGuard: assertFixtureSandbox }),
    ],
    repository,
    objectStore,
  });

  return {
    sandbox,
    repository,
    discovery,
    platformRoots: [sandbox.codexHome, sandbox.dshHome] as const,
    cleanup: async () => {
      repository.close();
      await sandbox.cleanup();
    },
  };
}
