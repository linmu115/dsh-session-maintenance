import { describe, expect, it } from "vitest";

import type { SyncPlan } from "@linmu/dsh-session-contracts";

import { loadWorkbenchInitial, planApplyState, type WorkbenchApi } from "../src/session-workbench.js";

const at = "2026-08-27T00:00:00.000Z";

describe("session workbench model", () => {
  it("loads graph metadata but keeps version bodies and diffs lazy", async () => {
    const calls: string[] = [];
    const api = {
      getSession: async () => {
        calls.push("session");
        return {
          summary: { logicalSessionId: "logical-1", title: "fixture", archived: false, platforms: ["codex"], status: "unmapped", updatedAt: at },
          bindings: [], heads: [],
        };
      },
      getGraph: async () => {
        calls.push("graph");
        return { nodes: [], refs: [] };
      },
      listCheckpoints: async () => { calls.push("checkpoints"); return []; },
      getVersion: async () => { calls.push("version"); throw new Error("not expected"); },
      getDiff: async () => { calls.push("diff"); throw new Error("not expected"); },
    } as unknown as WorkbenchApi;
    await loadWorkbenchInitial(api, "logical-1");
    expect(calls.sort()).toEqual(["checkpoints", "graph", "session"]);
  });

  it("enables only confirmation-free safe plans", () => {
    const safe: SyncPlan = {
      schemaVersion: 1,
      id: "plan-safe",
      hash: "hash-safe",
      createdAt: at,
      logicalSessionId: "logical-1",
      source: { bindingId: "source", key: { platform: "codex", instanceId: "codex", sessionId: "one" }, versionId: "version-1", fingerprints: [] },
      adapterContracts: [],
      operations: [{ type: "append-events", fromIndex: 0, eventIds: ["event-1"] }],
      risk: "safe",
      confirmations: [],
      preconditions: [],
    };
    expect(planApplyState(safe).allowed).toBe(true);
    expect(planApplyState({ ...safe, id: "plan-review", risk: "review", confirmations: [{ kind: "review", code: "DIVERGED", message: "review" }] }).allowed).toBe(false);
    expect(planApplyState({ ...safe, id: "plan-destructive", risk: "destructive" }).allowed).toBe(false);
  });
});
