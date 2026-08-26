import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  assertFixtureSandbox,
  createFixtureSandbox,
  writeCodexFixtureHome,
  writeDshFixtureHome,
} from "../../../packages/test-support/src/index.js";
import { runCli as executeCli } from "../src/cli.js";

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
