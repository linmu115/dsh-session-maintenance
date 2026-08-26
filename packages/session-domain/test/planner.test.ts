import { describe, expect, it } from "vitest";

import {
  createSyncPlan,
  validatePlanPreconditions,
  type CreateSyncPlanRequest,
} from "../src/index.js";

import {
  adapterContracts,
  appendOnlyPlanFixture,
  event,
  planningHead,
} from "./plan-fixtures.js";

const fixedTime = "2026-08-26T00:00:00.000Z";

describe("sync planner", () => {
  it("creates deterministic append-only plans and rejects stale fingerprints", () => {
    const first = createSyncPlan(appendOnlyPlanFixture(fixedTime));
    expect(createSyncPlan(appendOnlyPlanFixture(fixedTime))).toEqual(first);
    expect(first.operations.map((operation) => operation.type)).toEqual(["append-events"]);
    expect(first.id).toMatch(/^plan_[0-9a-f]{24}$/u);
    expect(first.hash).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const changed = first.preconditions.map((fingerprint, index) =>
      index === 0 ? { ...fingerprint, value: "changed" } : fingerprint,
    );
    expect(() => validatePlanPreconditions(first, changed)).toThrow(/PLAN_STALE/u);
    expect(() => validatePlanPreconditions(first, [...first.preconditions].reverse())).not.toThrow();
  });

  it("handles safe no-op, reverse prefix, metadata and missing targets", () => {
    const append = appendOnlyPlanFixture(fixedTime);
    const equal = createSyncPlan({
      ...append,
      source: append.target.kind === "present" ? append.target.head : append.source,
    });
    expect(equal.operations).toEqual([]);

    const targetAhead = createSyncPlan({
      ...append,
      source: append.target.kind === "present" ? append.target.head : append.source,
      target: { kind: "present", head: append.source },
    });
    expect(targetAhead.operations).toEqual([]);

    const renamed = createSyncPlan({
      ...append,
      source: { ...append.source, events: append.base.events, metadata: { ...append.base.metadata, title: "New" } },
    });
    expect(renamed.operations).toEqual([{ type: "update-title", title: "New" }]);

    const archived = createSyncPlan({
      ...append,
      source: { ...append.source, events: append.base.events, metadata: { ...append.base.metadata, archived: true } },
    });
    expect(archived.operations).toEqual([{ type: "update-archive", archived: true }]);

    const missingKey = { platform: "dsh" as const, instanceId: "dsh-fixture", sessionId: "missing" };
    expect(
      createSyncPlan({
        ...append,
        target: { kind: "missing", key: missingKey, targetInstanceId: "dsh-fixture", previouslyObserved: true },
      }).operations,
    ).toEqual([{ type: "deletion-candidate", missing: missingKey }]);
    expect(
      createSyncPlan({
        ...append,
        target: { kind: "missing", key: missingKey, targetInstanceId: "dsh-fixture", previouslyObserved: false },
      }).operations,
    ).toEqual([{ type: "create-target-session", targetInstanceId: "dsh-fixture" }]);
  });

  it.each([
    ["DIVERGED", (request: CreateSyncPlanRequest): CreateSyncPlanRequest => ({
      ...request,
      source: planningHead("source", "codex", "source", [...request.base.events, event("e1", "codex")]),
      target: { kind: "present", head: planningHead("target", "dsh", "target", [...request.base.events, event("e2", "dsh")]) },
    })],
    ["REWRITTEN", (request: CreateSyncPlanRequest): CreateSyncPlanRequest => ({
      ...request,
      source: planningHead("source", "codex", "source", [event("e0", "edited")]),
      target: { kind: "present", head: planningHead("target", "dsh", "target", request.base.events) },
    })],
    ["METADATA_CONFLICT", (request: CreateSyncPlanRequest): CreateSyncPlanRequest => ({
      ...request,
      source: planningHead("source", "codex", "source", request.base.events, "Codex"),
      target: { kind: "present", head: planningHead("target", "dsh", "target", request.base.events, "DSH") },
    })],
    ["IDENTITY_CONFLICT", (request: CreateSyncPlanRequest): CreateSyncPlanRequest => ({ ...request, identityConflict: true })],
  ] as const)("creates only require-review for %s", (reason, mutate) => {
    const plan = createSyncPlan(mutate(appendOnlyPlanFixture(fixedTime)));
    expect(plan.operations).toEqual([{ type: "require-review", reason }]);
    expect(plan.risk).toBe("review");
  });

  it("requires exact fingerprint set equality", () => {
    const plan = createSyncPlan(appendOnlyPlanFixture(fixedTime));
    expect(() => validatePlanPreconditions(plan, plan.preconditions.slice(1))).toThrow(/PLAN_STALE/u);
    expect(() => validatePlanPreconditions(plan, [...plan.preconditions, plan.preconditions[0]!])).toThrow(
      /PLAN_STALE/u,
    );
  });
});
