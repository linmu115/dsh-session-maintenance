import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  NormalizedEvent,
  NormalizedSession,
  RegisteredInstance,
  SyncPlan,
  TransactionContext,
} from "@linmu/dsh-session-contracts";
import {
  assertFixtureSandbox,
  createFixtureSandbox,
  writeCodexFixtureHome,
  type FixtureSandbox,
} from "@linmu/dsh-session-test-support";

import { CodexNativeWriteAdapter } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

function event(id: string, sequence: number, role: NormalizedEvent["role"], content: string, kind: NormalizedEvent["kind"] = "message"): NormalizedEvent {
  return {
    id,
    parentId: null,
    sequence,
    kind,
    role,
    content,
    attachments: [],
    source: { platform: "dsh", instanceId: "dsh", sessionId: "source", eventId: id, sequence },
    extensions: kind === "tool-import" ? { tool: "fixture" } : {},
  };
}

function source(): NormalizedSession {
  return {
    schemaVersion: 1,
    key: { platform: "dsh", instanceId: "dsh", sessionId: "source" },
    title: "Mirrored fixture",
    archived: false,
    workspaceId: null,
    events: [
      event("e0", 0, "user", "hello from fixture"),
      event("e1", 1, "assistant", "fixture response"),
      event("e2", 2, "tool", "[DSH imported tool record: fixture]", "tool-import"),
    ],
    bodyHash: "body-source",
    metadataHash: "metadata-source",
    provenance: { platform: "dsh", instanceId: "dsh", sessionId: "source", observedAt: "2026-08-27T00:00:00.000Z" },
    compatibility: { status: "compatible", issues: [] },
  };
}

function plan(): SyncPlan {
  return {
    schemaVersion: 1,
    id: "plan-native",
    hash: "sha256:plan-native",
    createdAt: "2026-08-27T00:00:00.000Z",
    logicalSessionId: "logical-native",
    baseVersionId: "base",
    source: { bindingId: "dsh-binding", key: { platform: "dsh", instanceId: "dsh", sessionId: "source" }, versionId: "source-version", fingerprints: [] },
    target: { bindingId: "codex-binding", key: { platform: "codex", instanceId: "codex", sessionId: "thread-fixture" }, versionId: "target-version", fingerprints: [] },
    adapterContracts: [],
    operations: [
      { type: "append-events", fromIndex: 2, eventIds: ["e2"] },
      { type: "update-title", title: "Mirrored fixture" },
    ],
    risk: "safe",
    confirmations: [],
    preconditions: [],
  };
}

function instance(sandbox: FixtureSandbox, platformVersion = "0.146.0"): RegisteredInstance {
  return { id: "codex", platform: "codex", displayName: "Codex fixture", root: sandbox.codexHome, platformVersion };
}

describe("CodexNativeWriteAdapter", () => {
  it("fail-closes unsupported/busy homes and publishes then restores all managed files", async () => {
    const sandbox = await createFixtureSandbox("codex-native");
    cleanups.push(sandbox.cleanup);
    await writeCodexFixtureHome(sandbox.codexHome);
    const stateRoot = join(sandbox.root, "maintenance-state");
    const adapter = new CodexNativeWriteAdapter({
      stateRoot,
      loadSource: async () => source(),
      fixtureGuard: assertFixtureSandbox,
      quietDelayMs: 1,
    });

    expect((await adapter.probeWrite(instance(sandbox, "0.147.0"))).status).toBe("unsupported");
    await writeFile(join(sandbox.codexHome, ".dsh-session-maintenance-busy"), "busy\n");
    expect((await adapter.probeWrite(instance(sandbox))).status).toBe("degraded");
    await import("node:fs/promises").then(({ unlink }) => unlink(join(sandbox.codexHome, ".dsh-session-maintenance-busy")));

    const rolloutPath = join(sandbox.codexHome, "rollouts", "thread-fixture.jsonl");
    const original = {
      database: await readFile(join(sandbox.codexHome, "state_5.sqlite")),
      index: await readFile(join(sandbox.codexHome, "session_index.jsonl")),
      rollout: await readFile(rolloutPath),
    };
    const transaction: TransactionContext = { id: "tx-native", planId: plan().id, planHash: plan().hash, startedAt: "2026-08-27T00:00:00.000Z" };
    const prepared = await adapter.prepare({ plan: plan(), instance: instance(sandbox), transaction });
    const backup = await adapter.backup(prepared, transaction);
    expect(backup.entries.map((entry) => entry.logicalName)).toEqual(expect.arrayContaining(["state_5.sqlite", "session_index.jsonl", "rollout-source"]));
    const receipt = await adapter.commit(prepared, transaction);
    expect((await adapter.verify(receipt, prepared.expected)).ok).toBe(true);
    expect(await readFile(rolloutPath, "utf8")).toContain("DSH 导入记录");

    expect((await adapter.restore(backup, transaction)).restored).toBe(true);
    expect(await readFile(join(sandbox.codexHome, "state_5.sqlite"))).toEqual(original.database);
    expect(await readFile(join(sandbox.codexHome, "session_index.jsonl"))).toEqual(original.index);
    expect(await readFile(rolloutPath)).toEqual(original.rollout);
  });
});
