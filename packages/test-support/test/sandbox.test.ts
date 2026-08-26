import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { lstat, mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertFixtureSandbox,
  createFixtureSandbox,
  writeCodexFixtureHome,
  writeDshFixtureHome,
} from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

async function filesBelow(root: string): Promise<readonly string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        output.push(path);
      }
    }
  };
  await visit(root);
  return output.sort();
}

async function treeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const path of await filesBelow(root)) {
    hash.update(relative(root, path).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("fixture sandbox", () => {
  it("rejects live homes and accepts only marked temporary descendants", async () => {
    expect(() => assertFixtureSandbox(join(homedir(), ".codex"))).toThrow(/LIVE_HOME_FORBIDDEN/u);

    const sandbox = await createFixtureSandbox("guard");
    cleanups.push(sandbox.cleanup);
    expect(() => assertFixtureSandbox(sandbox.root)).not.toThrow();
    expect(() => assertFixtureSandbox(sandbox.codexHome)).not.toThrow();
    expect(() => assertFixtureSandbox(sandbox.dshHome)).not.toThrow();

    const unmarked = join(sandbox.root, "unmarked-child");
    await mkdir(unmarked);
    await rm(join(sandbox.root, ".dsh-session-maintenance-fixture"));
    expect(() => assertFixtureSandbox(unmarked)).toThrow(/LIVE_HOME_FORBIDDEN/u);
  });

  it("materializes byte-identical, synthetic platform homes", async () => {
    const first = await createFixtureSandbox("deterministic-a");
    const second = await createFixtureSandbox("deterministic-b");
    cleanups.push(first.cleanup, second.cleanup);

    await writeCodexFixtureHome(first.codexHome);
    await writeDshFixtureHome(first.dshHome);
    await writeCodexFixtureHome(second.codexHome);
    await writeDshFixtureHome(second.dshHome);

    expect(await treeDigest(first.codexHome)).toBe(await treeDigest(second.codexHome));
    expect(await treeDigest(first.dshHome)).toBe(await treeDigest(second.dshHome));
    expect((await lstat(join(first.dshHome, "sessions", "project-fixture", "dsh-session-1", "session.jsonl.zstd"))).isFile()).toBe(true);
  });

  it("rejects escaping junctions and linked fixture markers", async () => {
    const sandbox = await createFixtureSandbox("junction-guard");
    cleanups.push(sandbox.cleanup);
    const escape = join(sandbox.root, "escape");
    await symlink(homedir(), escape, "junction");
    expect(() => assertFixtureSandbox(escape)).toThrow(/LIVE_HOME_FORBIDDEN/u);
    await rm(escape);

    const marker = join(sandbox.root, ".dsh-session-maintenance-fixture");
    const markerTarget = join(sandbox.root, "marker-target");
    await rm(marker);
    await mkdir(markerTarget);
    await symlink(markerTarget, marker, "junction");
    expect(() => assertFixtureSandbox(sandbox.root)).toThrow(/LIVE_HOME_FORBIDDEN/u);
  });

  it("keeps committed fixture sources free of local and credential-shaped data", async () => {
    const fixtureRoot = join(import.meta.dirname, "..", "..", "..", "fixtures");
    const source = Buffer.concat(
      await Promise.all((await filesBelow(fixtureRoot)).map((path) => readFile(path))),
    ).toString("utf8");
    const accountName = process.env.USERNAME ?? "__missing_username__";

    expect(source.toLocaleLowerCase()).not.toContain(accountName.toLocaleLowerCase());
    expect(source).not.toMatch(/OneDrive|DeepSeek-Harness|D:\\AI/iu);
    expect(source).not.toMatch(/(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9]{20,})/u);
    expect(source).toMatch(/synthetic:\s*true/gu);
    expect(source).toMatch(/containsUserData:\s*false/gu);
  });
});
