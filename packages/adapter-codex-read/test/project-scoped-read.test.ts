import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { RegisteredInstance } from "@linmu/dsh-session-contracts";
import { assertFixtureSandbox, createFixtureSandbox, writeCodexFixtureHome } from "@linmu/dsh-session-test-support";
import { CodexReadAdapter, readCodexSessionChangeFingerprint, readCodexSessionChangeStamp } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
async function fixture() {
  const sandbox = await createFixtureSandbox("codex-project-scoped-read");
  cleanups.push(sandbox.cleanup);
  await writeCodexFixtureHome(sandbox.codexHome);
  const instance: RegisteredInstance = { id: "fixture", platform: "codex", displayName: "Fixture", root: sandbox.codexHome, platformVersion: "0.146.0" };
  const sql = (text: string) => { const db = new DatabaseSync(join(sandbox.codexHome, "state_5.sqlite")); try { db.exec(text); } finally { db.close(); } };
  return { instance, sql, home: sandbox.codexHome };
}
async function collect<T>(items: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const item of items) result.push(item); return result; }

describe("Codex reads with an explicit project membership scope", () => {
  it("never probes or stats an unselected bad rollout, including an empty selection", async () => {
    const f = await fixture();
    f.sql("UPDATE threads SET rollout_path='missing-unselected.jsonl'");
    for (const ids of [new Set<string>(), new Set(["different-selected-id"])]) {
      const reader = new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox, threadIds: ids });
      expect((await reader.probe(f.instance)).status).toBe("compatible");
      expect(await collect(reader.list(f.instance))).toEqual([]);
      expect(reader.debugCounters()).toEqual({ rolloutBodyReads: 0, rolloutProbeReads: 0 });
      await expect(reader.observe(f.instance, { platform: "codex", instanceId: f.instance.id, sessionId: "thread-fixture" })).rejects.toThrow("outside the selected");
    }
    expect((await new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox }).probe(f.instance)).status).toBe("unsupported");
  });

  it("takes a closed copy of selected IDs and keeps normal selected body validation", async () => {
    const f = await fixture();
    const ids = new Set(["thread-fixture"]);
    const reader = new CodexReadAdapter({ fixtureGuard: assertFixtureSandbox, threadIds: ids });
    ids.clear();
    const [summary] = await collect(reader.list(f.instance));
    expect(summary?.key.sessionId).toBe("thread-fixture");
    expect((await reader.observe(f.instance, summary!.key)).kind).toBe("stable");
    expect(reader.debugCounters().rolloutBodyReads).toBeGreaterThan(0);
  });

  it("detects metadata-only and file changes without parsing a rollout body", async () => {
    const f = await fixture();
    const path = join(f.home, "rollouts", "thread-fixture.jsonl");
    await writeFile(path, "intentionally not JSONL");
    const before = await readFile(path);
    const read = () => readCodexSessionChangeFingerprint(f.instance, "thread-fixture", { fixtureGuard: assertFixtureSandbox });
    const first = await read();
    expect(await read()).toBe(first);
    f.sql("UPDATE threads SET title='Changed metadata'");
    const second = await read();
    expect(second).not.toBe(first);
    expect(await readFile(path)).toEqual(before);
    await appendFile(path, "changed bytes");
    expect(await read()).not.toBe(second);
  });

  it("captures title-only changes separately while archive and file changes require body observation", async () => {
    const f = await fixture();
    const read = () => readCodexSessionChangeStamp(f.instance, "thread-fixture", { fixtureGuard: assertFixtureSandbox });
    const first = await read();
    f.sql("UPDATE threads SET name='New display name',title='New title',updated_at=updated_at+1,updated_at_ms=updated_at_ms+1000");
    const renamed = await read();
    expect(renamed.title).toBe("New display name");
    expect(renamed.fingerprint).not.toBe(first.fingerprint);
    expect(renamed.bodyFingerprint).toBe(first.bodyFingerprint);
    f.sql("UPDATE threads SET archived=1");
    const archived = await read();
    expect(archived.bodyFingerprint).not.toBe(renamed.bodyFingerprint);
    await appendFile(join(f.home, "rollouts", "thread-fixture.jsonl"), "\n");
    expect((await read()).bodyFingerprint).not.toBe(archived.bodyFingerprint);
  });
});
