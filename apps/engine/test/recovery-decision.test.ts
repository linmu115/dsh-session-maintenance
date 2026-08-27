import { describe, expect, it } from "vitest";

import type { TransactionRecord } from "@linmu/dsh-session-contracts";

import { transactionRecoveryDecision } from "../src/engine.js";

const transaction = (status: TransactionRecord["status"]): TransactionRecord => ({
  id: "transaction-fixture",
  planId: "plan-fixture",
  planHash: "plan-hash-fixture",
  platform: "dsh",
  instanceId: "dsh-fixture",
  rootIdentity: "fixture-root",
  adapterContract: { adapter: "fixture", platformVersion: "0.1.1-rc.2", schemaFingerprint: "fixture-v1" },
  status,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
});

describe("transactionRecoveryDecision", () => {
  it("admits only scoped interrupted recovery or completed backup restore", () => {
    expect(transactionRecoveryDecision(true, transaction("applying"), "sha256:backup")).toMatchObject({ action: "recover-interrupted", allowed: true, confirmationRequired: true });
    expect(transactionRecoveryDecision(true, transaction("completed"), "sha256:backup")).toMatchObject({ action: "restore-completed", allowed: true, confirmationRequired: true });
    expect(transactionRecoveryDecision(true, transaction("manual-review"), "sha256:backup")).toMatchObject({ action: "none", allowed: false });
    expect(transactionRecoveryDecision(false, transaction("applying"), "sha256:backup")).toMatchObject({ action: "none", allowed: false });
  });
});
