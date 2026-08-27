import { afterEach, describe, expect, it } from "vitest";

import { createSyncPlan } from "../../packages/session-domain/src/index.js";
import { appendOnlyPlanFixture, event, planningHead } from "../../packages/session-domain/test/plan-fixtures.js";
import { createReadOnlyTestSystem, hashTree } from "./helpers/read-only-system.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));
const at = "2026-08-26T00:00:00.000Z";

function outcome(plan: ReturnType<typeof createSyncPlan>): string {
  const operation = plan.operations[0];
  if (operation === undefined) return "skip";
  return operation.type === "require-review" ? operation.reason : operation.type;
}

describe("phase-one acceptance matrix", () => {
  it("classifies safe, review and destructive dry-run operations", () => {
    const append = appendOnlyPlanFixture(at);
    const base = append.base.events;
    const cases = {
      unchanged: createSyncPlan({ ...append, source: append.target.kind === "present" ? append.target.head : append.source }),
      sourcePrefixGrowth: createSyncPlan(append),
      targetPrefixGrowth: createSyncPlan({ ...append, source: planningHead("source", "codex", "source", [...base, event("e2", "target growth")]) }),
      dualAppend: createSyncPlan({
        ...append,
        source: planningHead("source", "codex", "source", [...base, event("e1", "source")]),
        target: { kind: "present", head: planningHead("target", "dsh", "target", [...base, event("e2", "target")]) },
      }),
      rewrittenHistory: createSyncPlan({ ...append, source: planningHead("source", "codex", "source", [event("e0", "rewritten")]) }),
      oneSidedRename: createSyncPlan({ ...append, source: planningHead("source", "codex", "source", base, "Renamed") }),
      dualRename: createSyncPlan({
        ...append,
        source: planningHead("source", "codex", "source", base, "Codex"),
        target: { kind: "present", head: planningHead("target", "dsh", "target", base, "DSH") },
      }),
      archivedMirrorMetadata: createSyncPlan({ ...append, source: planningHead("source", "codex", "source", base, "Session", true) }),
      missingPreviouslyObservedSession: createSyncPlan({
        ...append,
        target: { kind: "missing", key: { platform: "dsh", instanceId: "dsh", sessionId: "missing" }, targetInstanceId: "dsh", previouslyObserved: true },
      }),
      reusedUuidWithUnrelatedBody: createSyncPlan({ ...append, identityConflict: true }),
    };
    expect(Object.fromEntries(Object.entries(cases).map(([name, plan]) => [name, outcome(plan)]))).toEqual({
      unchanged: "skip",
      sourcePrefixGrowth: "append-events",
      targetPrefixGrowth: "append-events",
      dualAppend: "DIVERGED",
      rewrittenHistory: "REWRITTEN",
      oneSidedRename: "update-title",
      dualRename: "METADATA_CONFLICT",
      archivedMirrorMetadata: "update-archive",
      missingPreviouslyObservedSession: "deletion-candidate",
      reusedUuidWithUnrelatedBody: "IDENTITY_CONFLICT",
    });
  });

  it("keeps both platform trees unchanged and the second discovery pass empty", async () => {
    const system = await createReadOnlyTestSystem();
    cleanups.push(system.cleanup);
    const before = await Promise.all(system.platformRoots.map(hashTree));
    await system.discovery.scanAll();
    expect(await system.discovery.scanAll()).toEqual({
      createdLogicalSessions: 0,
      createdBindings: 0,
      createdVersions: 0,
      createdCandidates: 0,
      skippedSessions: 0,
      platformWrites: 0,
    });
    expect(await Promise.all(system.platformRoots.map(hashTree))).toEqual(before);
  });
});
