import { describe, expect, it } from "vitest";

import { SessionMaintenanceError } from "@linmu/dsh-session-contracts";

import { createSyncPlan, validateExecutableDshPlan } from "../src/index.js";
import { appendOnlyPlanFixture, event, planningHead } from "./plan-fixtures.js";

const fixedTime = "2026-08-27T00:00:00.000Z";

describe("DSH write-plan gate", () => {
  it("admits only safe Codex-to-DSH fast-forward shapes", () => {
    const append = createSyncPlan(appendOnlyPlanFixture(fixedTime));
    expect(validateExecutableDshPlan(append)).toEqual({
      kind: "mutation",
      targetInstanceId: "dsh-fixture",
    });

    const request = appendOnlyPlanFixture(fixedTime);
    const noOp = createSyncPlan({
      ...request,
      source: planningHead(
        "binding-source",
        "codex",
        "version-source-equal",
        request.base.events,
      ),
    });
    expect(validateExecutableDshPlan(noOp)).toEqual({
      kind: "no-op",
      targetInstanceId: "dsh-fixture",
    });
  });

  it("rejects divergence before a platform writer can run", () => {
    const request = appendOnlyPlanFixture(fixedTime);
    const divergent = createSyncPlan({
      ...request,
      source: planningHead("source", "codex", "source", [...request.base.events, event("e1", "codex")]),
      target: {
        kind: "present",
        head: planningHead("target", "dsh", "target", [...request.base.events, event("e2", "dsh")]),
      },
    });

    expect(() => validateExecutableDshPlan(divergent)).toThrowError(
      expect.objectContaining<Partial<SessionMaintenanceError>>({
        code: "WRITE_CAPABILITY_UNAVAILABLE",
      }),
    );
  });
});
