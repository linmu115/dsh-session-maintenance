import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { createFixtureSystem, runCli } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("engine-private configuration", () => {
  it("registers only probed real roots and writes schema version 1", async () => {
    const fixture = await createFixtureSystem("config");
    cleanups.push(fixture.cleanup);
    expect((await runCli(["--state-root", fixture.stateRoot, "init", "--json"], fixture)).exitCode).toBe(0);
    const add = await runCli([
      "--state-root", fixture.stateRoot, "instance", "add", "--id", "codex-fixture",
      "--platform", "codex", "--root", fixture.codexHome, "--platform-version", "0.146.0", "--json",
    ], fixture);
    expect(add.exitCode).toBe(0);
    const config = parse(await readFile(join(fixture.stateRoot, "config.yaml"), "utf8")) as {
      readonly schemaVersion: number;
      readonly instances: Readonly<Record<string, { readonly root: string }>>;
    };
    expect(config.schemaVersion).toBe(1);
    expect(config.instances["codex-fixture"]?.root).toBe(fixture.codexHome);

    const duplicate = await runCli([
      "--state-root", fixture.stateRoot, "instance", "add", "--id", "codex-fixture",
      "--platform", "codex", "--root", fixture.codexHome, "--platform-version", "0.146.0", "--json",
    ], fixture);
    expect(duplicate.exitCode).toBe(1);
  });
});
