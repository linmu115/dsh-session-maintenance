import { appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadRepairPlan, visitRepairPlan } from "../src/conversation-repair-plan.js";
import { previewConversationTopologyRepair } from "../src/conversation-topology-repair.js";
import { createEngineFixture, hashTree } from "./helpers.js";

describe("frozen conversation repair plan", () => {
  it.each(["manifest", "body"] as const)("rejects changed %s without visiting a session", async (target) => {
    const fixture = await createEngineFixture(`repair-plan-${target}`);
    try {
      const instance = fixture.engine.instances.find((item) => item.platform === "codex")!;
      const sourceDatabasePath = join(fixture.stateRoot, "metadata.sqlite");
      const candidateFile = "metadata.snapshot-test.sqlite";
      const before = await hashTree(fixture.codexHome);
      const preview = await previewConversationTopologyRepair({
        stateRoot: fixture.stateRoot, sourceDatabasePath, candidateFile,
        codexInstance: instance, fixtureGuard: fixture.fixturePolicy,
      });
      const manifest = JSON.parse(await readFile(preview.planSnapshotPath, "utf8"));
      if (target === "manifest") {
        manifest.data.summary.scanned += 1;
        await writeFile(preview.planSnapshotPath, JSON.stringify(manifest));
      } else {
        await appendFile(join(dirname(preview.planSnapshotPath), `${manifest.data.bodies[0].digest}.json`), " ");
      }
      let visited = 0;
      await expect((async () => {
        const frozen = await loadRepairPlan({
          candidatePath: join(fixture.stateRoot, candidateFile), sourceDatabasePath,
          instance, expectedDigest: preview.codexPlanDigest,
        });
        await visitRepairPlan(frozen, async () => { visited += 1; });
      })()).rejects.toThrow(/digest/u);
      expect(visited).toBe(0);
      expect(await hashTree(fixture.codexHome)).toBe(before);
    } finally {
      await fixture.cleanupAll();
    }
  });

  it("does not overwrite a captured plan or consume an absent plan", async () => {
    const fixture = await createEngineFixture("repair-plan-exclusive");
    try {
      const instance = fixture.engine.instances.find((item) => item.platform === "codex")!;
      const input = {
        stateRoot: fixture.stateRoot, sourceDatabasePath: join(fixture.stateRoot, "metadata.sqlite"),
        candidateFile: "metadata.snapshot-test.sqlite", codexInstance: instance, fixtureGuard: fixture.fixturePolicy,
      };
      const preview = await previewConversationTopologyRepair(input);
      await expect(previewConversationTopologyRepair(input)).rejects.toMatchObject({ code: "EEXIST" });
      await expect(loadRepairPlan({
        candidatePath: join(fixture.stateRoot, "metadata.not-captured.sqlite"),
        sourceDatabasePath: input.sourceDatabasePath, instance, expectedDigest: preview.codexPlanDigest,
      })).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fixture.cleanupAll();
    }
  });
});
