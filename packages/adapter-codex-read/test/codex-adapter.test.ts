import { appendFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  RegisteredInstance,
  StableObservation,
  StableObservation as StableObservationType,
} from "@linmu/dsh-session-contracts";
import {
  assertFixtureSandbox,
  createFixtureSandbox,
  writeCodexFixtureHome,
  type FixtureSandbox,
} from "@linmu/dsh-session-test-support";

import { CodexReadAdapter } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
};

function expectStable(observation: StableObservationType | { readonly kind: "unstable" }): StableObservation {
  expect(observation.kind).toBe("stable");
  return observation as StableObservation;
}

function instance(sandbox: FixtureSandbox): RegisteredInstance {
  return {
    id: "codex-fixture",
    platform: "codex",
    displayName: "fixture",
    root: sandbox.codexHome,
    platformVersion: "0.146.0",
  };
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("CodexReadAdapter", () => {
  it("probes, lists, observes, normalizes and verifies without writes", async () => {
    const sandbox = await createFixtureSandbox("codex-read");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    const adapter = new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox });
    const registered = instance(sandbox);

    expect((await adapter.probe(registered)).status).toBe("compatible");
    adapter.resetDebugCounters();
    const summaries = await collect(adapter.list(registered));
    expect(summaries).toHaveLength(1);
    expect(adapter.debugCounters().rolloutBodyReads).toBe(0);

    const observed = expectStable(
      await adapter.observe(registered, summaries[0]!.key, summaries[0]!.hint),
    );
    const normalized = await adapter.normalize(observed);
    expect(normalized.events.map((event) => event.role)).toEqual(["user", "assistant"]);
    expect(adapter.debugCounters().rolloutBodyReads).toBe(1);
    expect(
      (
        await adapter.verify(registered, summaries[0]!.key, {
          fingerprints: [observed.fingerprint],
        })
      ).ok,
    ).toBe(true);
  });

  it("lists 100 summaries without reading rollout bodies", async () => {
    const sandbox = await createFixtureSandbox("codex-catalog");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    const database = new DatabaseSync(join(sandbox.codexHome, "state_5.sqlite"));
    const insert = database.prepare(
      `INSERT INTO threads
        (id, rollout_path, title, name, cwd, created_at, updated_at, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 2; index <= 100; index += 1) {
      insert.run(
        `thread-${index}`,
        "rollouts/thread-fixture.jsonl",
        `Fixture ${index}`,
        "fixture",
        "C:\\fixture\\workspace",
        "2026-08-26T00:00:00.000Z",
        "2026-08-26T00:00:02.000Z",
        0,
      );
    }
    database.close();

    const adapter = new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox });
    adapter.resetDebugCounters();
    expect(await collect(adapter.list(instance(sandbox)))).toHaveLength(100);
    expect(adapter.debugCounters()).toMatchObject({ rolloutBodyReads: 0, rolloutProbeReads: 0 });
  });

  it("returns unstable when the file changes during observation", async () => {
    const sandbox = await createFixtureSandbox("codex-unstable");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    const adapter = new CodexReadAdapter({
      fixtureGuard: assertFixtureSandbox,
      afterRead: async (path) => appendFile(path, " \n"),
    });
    const registered = instance(sandbox);
    const [summary] = await collect(adapter.list(registered));
    expect((await adapter.observe(registered, summary!.key, summary!.hint)).kind).toBe("unstable");
  });

  it("preserves unknown envelopes as degraded source metadata", async () => {
    const sandbox = await createFixtureSandbox("codex-degraded");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    await appendFile(
      join(sandbox.codexHome, "rollouts", "thread-fixture.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-08-26T00:00:03.000Z",
        type: "response_item",
        payload: { type: "function_call", name: "synthetic", arguments: "{}" },
      })}\n`,
    );
    const adapter = new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox });
    const registered = instance(sandbox);
    const [summary] = await collect(adapter.list(registered));
    const normalized = await adapter.normalize(
      expectStable(await adapter.observe(registered, summary!.key, summary!.hint)),
    );

    expect(normalized.compatibility.status).toBe("degraded");
    expect(normalized.events.at(-1)).toMatchObject({ kind: "metadata", role: "unknown" });
    expect(normalized.events.some((item) => item.kind === "tool-import")).toBe(false);
  });
});
