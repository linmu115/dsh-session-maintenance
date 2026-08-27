import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RegisteredInstance, StableObservation } from "@linmu/dsh-session-contracts";
import {
  assertFixtureSandbox,
  createFixtureSandbox,
  writeDshFixtureHome,
  type FixtureSandbox,
} from "@linmu/dsh-session-test-support";

import { DshReadAdapter } from "../src/index.js";
import { encodeFixtureArtifact } from "../src/testing.js";

const cleanups: Array<() => Promise<void>> = [];

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
};

function registered(sandbox: FixtureSandbox, version = "0.1.1-rc.2"): RegisteredInstance {
  return {
    id: "dsh-fixture",
    platform: "dsh",
    displayName: "fixture",
    root: sandbox.dshHome,
    platformVersion: version,
  };
}

function stable(value: { readonly kind: string }): StableObservation {
  expect(value.kind).toBe("stable");
  return value as StableObservation;
}

async function treeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        hash.update(relative(root, path).replaceAll("\\", "/"));
        hash.update(await readFile(path));
      }
    }
  };
  await visit(root);
  return hash.digest("hex");
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("DshReadAdapter", () => {
  it("probes, lists, observes and normalizes without platform writes", async () => {
    const sandbox = await createFixtureSandbox("dsh-read");
    cleanups.push(sandbox.cleanup);
    await writeDshFixtureHome(sandbox.dshHome);
    const before = await treeDigest(sandbox.dshHome);
    const adapter = new DshReadAdapter({ fixtureGuard: assertFixtureSandbox });
    const instance = registered(sandbox);

    expect((await adapter.probe(instance)).status).toBe("compatible");
    adapter.resetDebugCounters();
    const [summary] = await collect(adapter.list(instance));
    expect(adapter.debugCounters()).toMatchObject({ headerFrameReads: 1, fullArtifactReads: 0 });
    expect(summary).toMatchObject({
      title: "Fixture conversation",
      archived: false,
      workspaceId: "workspace-fixture",
    });
    const observation = stable(await adapter.observe(instance, summary!.key, summary!.hint));
    const normalized = await adapter.normalize(observation);
    expect(normalized.events.map((event) => event.role)).toEqual(["user", "assistant", "tool"]);
    expect(normalized.events.at(-1)).toMatchObject({ kind: "tool-import", role: "tool" });
    expect((await adapter.verify(instance, summary!.key, { fingerprints: [observation.fingerprint] })).ok).toBe(true);
    expect(await treeDigest(sandbox.dshHome)).toBe(before);
  });

  it("lists 100 header frames and fully reads only the observed artifact", async () => {
    const sandbox = await createFixtureSandbox("dsh-lazy");
    cleanups.push(sandbox.cleanup);
    await writeDshFixtureHome(sandbox.dshHome);
    const source = join(
      sandbox.dshHome,
      "sessions",
      "project-fixture",
      "dsh-session-1",
      "session.jsonl.zstd",
    );
    for (let index = 2; index <= 100; index += 1) {
      const directory = join(sandbox.dshHome, "sessions", "project-fixture", `dsh-session-${index}`);
      await mkdir(directory);
      await writeFile(
        join(directory, "session.jsonl.zstd"),
        encodeFixtureArtifact(
          { type: "session", version: 0, id: `dsh-session-${index}`, createdAt: index, cwd: "C:\\fixture\\workspace", delegationDepth: 0 },
          [{ type: "user/message", seq: 0, time: 1, data: { content: [{ type: "text", text: "fixture" }] } }],
        ),
      );
    }
    expect((await readFile(source)).byteLength).toBeGreaterThan(0);

    const adapter = new DshReadAdapter({ fixtureGuard: assertFixtureSandbox });
    adapter.resetDebugCounters();
    const summaries = await collect(adapter.list(registered(sandbox)));
    expect(summaries).toHaveLength(100);
    expect(adapter.debugCounters()).toMatchObject({ headerFrameReads: 100, fullArtifactReads: 0 });
    await adapter.observe(registered(sandbox), summaries[0]!.key, summaries[0]!.hint);
    expect(adapter.debugCounters().fullArtifactReads).toBe(1);
  });

  it("reports unsupported versions and session headers without guessing", async () => {
    const sandbox = await createFixtureSandbox("dsh-unsupported");
    cleanups.push(sandbox.cleanup);
    await writeDshFixtureHome(sandbox.dshHome);
    const adapter = new DshReadAdapter({ fixtureGuard: assertFixtureSandbox });
    expect((await adapter.probe(registered(sandbox, "0.1.2"))).status).toBe("unsupported");

    await writeFile(
      join(sandbox.dshHome, "sessions", "project-fixture", "dsh-session-1", "session.jsonl.zstd"),
      encodeFixtureArtifact(
        { type: "session", version: 1, id: "dsh-session-1", createdAt: 1, cwd: "C:\\fixture", delegationDepth: 0 },
        [],
      ),
    );
    expect((await adapter.probe(registered(sandbox))).status).toBe("unsupported");
  });

  it("rejects duplicate IDs and escaped artifact links", async () => {
    const sandbox = await createFixtureSandbox("dsh-paths");
    cleanups.push(sandbox.cleanup);
    await writeDshFixtureHome(sandbox.dshHome);
    const adapter = new DshReadAdapter({ fixtureGuard: assertFixtureSandbox });
    const original = join(sandbox.dshHome, "sessions", "project-fixture", "dsh-session-1", "session.jsonl.zstd");
    const duplicateDirectory = join(sandbox.dshHome, "sessions", "project-fixture", "duplicate");
    await mkdir(duplicateDirectory);
    await cp(original, join(duplicateDirectory, "session.jsonl.zstd"));
    await expect(collect(adapter.list(registered(sandbox)))).rejects.toThrow(/duplicate.*ID/iu);

    await rm(duplicateDirectory, { recursive: true });
    const outsideDirectory = join(sandbox.root, "outside-session-directory");
    await mkdir(outsideDirectory);
    await cp(original, join(outsideDirectory, "session.jsonl.zstd"));
    await symlink(outsideDirectory, duplicateDirectory, "junction");
    await expect(collect(adapter.list(registered(sandbox)))).rejects.toMatchObject({
      code: "LIVE_HOME_FORBIDDEN",
    });
  });
});
