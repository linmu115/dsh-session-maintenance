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
import {
  MAX_CODEX_LINE_BYTES,
  MAX_CODEX_ROLLOUT_BYTES,
  parseCodexJsonlChunks,
} from "../src/parser.js";

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
  it.each([
    { name: "original 38 columns", sql: "", contract: "/schema-3:" },
    { name: "known 40 columns", sql: "ALTER TABLE threads ADD COLUMN originator TEXT; ALTER TABLE threads ADD COLUMN daybreak_enabled BOOLEAN", contract: "/schema-4:" },
  ])("reads the $name contract without changing conversation semantics", async ({ sql, contract }) => {
    const sandbox = await createFixtureSandbox("codex-known-schema");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    if (sql) {
      const database = new DatabaseSync(join(sandbox.codexHome, "state_5.sqlite"));
      try { database.exec(sql); } finally { database.close(); }
    }
    const registered = instance(sandbox);
    const scoped = new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox, threadIds: new Set(["thread-fixture"]) });
    const scopedProbe = await scoped.probe(registered);
    expect(scopedProbe.status).toBe("compatible");
    expect(scopedProbe.contract.schemaFingerprint).toContain(contract);
    expect(scoped.debugCounters().rolloutProbeReads).toBe(0);

    const adapter = new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox });
    const probe = await adapter.probe(registered);
    expect(probe.status).toBe("compatible");
    expect(probe.contract).toEqual(scopedProbe.contract);
    const summaries = await collect(adapter.list(registered));
    expect(summaries).toHaveLength(1);
    const observation = await adapter.observe(registered, summaries[0]!.key, summaries[0]!.hint);
    expect(observation.kind).toBe("stable");
    if (observation.kind !== "stable") throw new Error("Synthetic known-schema observation was unstable");
    expect((await adapter.normalize(observation)).events.map(event => event.role)).toEqual(["user", "assistant"]);
  });

  it.each([
    { name: "only one known extra column", sql: "ALTER TABLE threads ADD COLUMN originator TEXT" },
    { name: "wrong originator type", sql: "ALTER TABLE threads ADD COLUMN originator INTEGER; ALTER TABLE threads ADD COLUMN daybreak_enabled BOOLEAN" },
    { name: "wrong daybreak type", sql: "ALTER TABLE threads ADD COLUMN originator TEXT; ALTER TABLE threads ADD COLUMN daybreak_enabled INTEGER" },
    { name: "changed original column type", sql: "ALTER TABLE threads DROP COLUMN project_id; ALTER TABLE threads ADD COLUMN project_id INTEGER; ALTER TABLE threads ADD COLUMN originator TEXT; ALTER TABLE threads ADD COLUMN daybreak_enabled BOOLEAN" },
    { name: "wrong nullability", sql: "ALTER TABLE threads ADD COLUMN originator TEXT NOT NULL DEFAULT ''; ALTER TABLE threads ADD COLUMN daybreak_enabled BOOLEAN" },
    { name: "reordered known extras", sql: "ALTER TABLE threads ADD COLUMN daybreak_enabled BOOLEAN; ALTER TABLE threads ADD COLUMN originator TEXT" },
    { name: "missing required column", sql: "ALTER TABLE threads DROP COLUMN project_id; ALTER TABLE threads ADD COLUMN originator TEXT; ALTER TABLE threads ADD COLUMN daybreak_enabled BOOLEAN" },
    { name: "unknown extra after known extras", sql: "ALTER TABLE threads ADD COLUMN originator TEXT; ALTER TABLE threads ADD COLUMN daybreak_enabled BOOLEAN; ALTER TABLE threads ADD COLUMN unexpected TEXT" },
  ])("rejects $name before reading any rollout body", async ({ sql }) => {
    const sandbox = await createFixtureSandbox("codex-rejected-schema");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    const database = new DatabaseSync(join(sandbox.codexHome, "state_5.sqlite"));
    try { database.exec(sql); } finally { database.close(); }
    const adapter = new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox });
    expect(await adapter.probe(instance(sandbox))).toMatchObject({
      status: "unsupported", capabilities: [],
      contract: { schemaFingerprint: "unsupported-schema" },
      issues: [{ code: "ADAPTER_INCOMPATIBLE" }],
    });
    expect(adapter.debugCounters()).toEqual({ rolloutBodyReads: 0, rolloutProbeReads: 0 });
  });

  it("parses JSONL incrementally across arbitrary chunk boundaries", async () => {
    const bytes = Buffer.from(
      '{"type":"session_meta","payload":{"id":"thread-stream"}}\r\n' +
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[]}}\n',
    );
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield bytes.subarray(0, 17);
      yield bytes.subarray(17, 73);
      yield bytes.subarray(73);
    }
    const parsed = await parseCodexJsonlChunks(chunks());
    expect(parsed.envelopes.map((item) => item.type)).toEqual(["session_meta", "response_item"]);
    expect(parsed.bytesRead).toBe(bytes.byteLength);
    expect(parsed.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(MAX_CODEX_ROLLOUT_BYTES).toBeGreaterThan(233_361_735);
    expect(MAX_CODEX_LINE_BYTES).toBeGreaterThan(9_805_006);
  });

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

  it("rejects truncated JSONL, escaped paths and conflicting root metadata while accepting embedded lineage", async () => {
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
    await expect(adapter.observe(registered, summary!.key)).resolves.toMatchObject({ kind: "stable" });

    const [rootLine, ...remainingLines] = original.trimEnd().split(/\r?\n/u);
    const rootEnvelope = JSON.parse(rootLine!) as { type: string; payload: { id: string } };
    rootEnvelope.payload.id = "another-thread";
    await writeFile(rollout, `${[JSON.stringify(rootEnvelope), ...remainingLines].join("\n")}\n`);
    await expect(adapter.observe(registered, summary!.key)).rejects.toMatchObject({ code: "IDENTITY_CONFLICT" });

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
