import { readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RegisteredInstance } from "@linmu/dsh-session-contracts";
import {
  assertFixtureSandbox,
  createFixtureSandbox,
  writeCodexFixtureHome,
  type FixtureSandbox,
} from "@linmu/dsh-session-test-support";

import { CodexReadAdapter } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

function instance(sandbox: FixtureSandbox, platformVersion = "0.146.0"): RegisteredInstance {
  return {
    id: "codex-fixture",
    platform: "codex",
    displayName: "fixture",
    root: sandbox.codexHome,
    platformVersion,
  };
}

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
};

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Codex adapter schema boundaries", () => {
  it("reports unknown platform versions and schema fingerprints as unsupported", async () => {
    const sandbox = await createFixtureSandbox("codex-schema");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    const adapter = new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox });

    expect((await adapter.probe(instance(sandbox, "0.147.0"))).status).toBe("unsupported");
    expect(adapter.debugCounters().rolloutProbeReads).toBe(0);
    const database = new DatabaseSync(join(sandbox.codexHome, "state_5.sqlite"));
    database.exec("ALTER TABLE threads ADD COLUMN unexpected TEXT");
    database.close();
    expect((await adapter.probe(instance(sandbox))).status).toBe("unsupported");
    expect(adapter.debugCounters().rolloutProbeReads).toBe(0);
  });

  it("rejects truncated JSONL, escaped paths and conflicting session metadata", async () => {
    const sandbox = await createFixtureSandbox("codex-corruption");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    const adapter = new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox });
    const registered = instance(sandbox);
    const rollout = join(sandbox.codexHome, "rollouts", "thread-fixture.jsonl");
    const [summary] = await collect(adapter.list(registered));

    const original = await readFile(rollout, "utf8");
    await writeFile(rollout, `${original}{`);
    await expect(adapter.observe(registered, summary!.key)).rejects.toThrow(/malformed JSONL/iu);

    await writeFile(
      rollout,
      `${original}${JSON.stringify({ type: "session_meta", payload: { id: "another-thread" } })}\n`,
    );
    await expect(adapter.observe(registered, summary!.key)).rejects.toThrow(/does not match catalog ID/iu);

    const outside = join(sandbox.root, "outside-rollout.jsonl");
    await writeFile(outside, original);
    const database = new DatabaseSync(join(sandbox.codexHome, "state_5.sqlite"));
    database.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(outside, "thread-fixture");
    database.close();
    await expect(collect(adapter.list(registered))).rejects.toMatchObject({
      code: "LIVE_HOME_FORBIDDEN",
    });
  });
});
