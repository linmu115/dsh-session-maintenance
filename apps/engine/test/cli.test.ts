import { afterEach, describe, expect, it } from "vitest";

import { createFixtureSystem, hashTree, runCli } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("read-only CLI", () => {
  it("scans marked Codex data twice without platform writes", async () => {
    const fixture = await createFixtureSystem("cli");
    cleanups.push(fixture.cleanup);
    const before = await hashTree(fixture.platformRoot);
    await runCli(["--state-root", fixture.stateRoot, "init", "--json"], fixture);
    await runCli([
      "--state-root", fixture.stateRoot, "instance", "add", "--id", "codex-fixture",
      "--platform", "codex", "--root", fixture.codexHome, "--platform-version", "0.146.0", "--json",
    ], fixture);
    const first = await runCli(["--state-root", fixture.stateRoot, "scan", "--instance", "codex-fixture", "--json"], fixture);
    const second = await runCli(["--state-root", fixture.stateRoot, "scan", "--instance", "codex-fixture", "--json"], fixture);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ createdVersions: 1, platformWrites: 0 });
    expect(JSON.parse(second.stdout)).toMatchObject({ createdVersions: 0, platformWrites: 0 });
    expect(await hashTree(fixture.platformRoot)).toBe(before);
  });

  it("refuses phase-one write commands with exit code 2", async () => {
    const fixture = await createFixtureSystem("unsupported");
    cleanups.push(fixture.cleanup);
    const result = await runCli(["--state-root", fixture.stateRoot, "apply", "--plan", "plan_x", "--json"], fixture);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ code: "CAPABILITY_NOT_AVAILABLE" });
  });
});
