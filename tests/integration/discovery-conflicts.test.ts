import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createReadOnlyTestSystem } from "./helpers/read-only-system.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("discovery identity policy", () => {
  it("uses title equality only as a low-confidence candidate", async () => {
    const system = await createReadOnlyTestSystem();
    cleanups.push(system.cleanup);
    await system.discovery.scanAll();
    const sessions = await system.repository.listSessions({ limit: 10 });
    const candidates = (
      await Promise.all(
        sessions.items.map((session) =>
          system.repository.listMatchCandidates(session.logicalSessionId),
        ),
      )
    ).flat();

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ confidence: "low" });
    expect((await system.repository.counts()).logicalSessions).toBe(2);
  });

  it("blocks a reused platform UUID with unrelated conversation content", async () => {
    const system = await createReadOnlyTestSystem();
    cleanups.push(system.cleanup);
    await system.discovery.scanInstance("codex-fixture");
    const rollout = join(system.sandbox.codexHome, "rollouts", "thread-fixture.jsonl");
    const [sessionMeta] = (await readFile(rollout, "utf8")).split(/\r?\n/u);
    await writeFile(
      rollout,
      `${sessionMeta}\n${JSON.stringify({
        timestamp: "2026-08-26T00:10:00.000Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "unrelated replacement" }] },
      })}\n`,
    );

    await expect(system.discovery.scanInstance("codex-fixture")).rejects.toMatchObject({
      code: "IDENTITY_CONFLICT",
    });
  });
});
