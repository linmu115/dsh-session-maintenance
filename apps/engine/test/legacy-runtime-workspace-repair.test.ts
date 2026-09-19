import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { REQUIRED_CAPABILITIES, v3NativeSessionCodec } from "@linmu/dsh-session-adapter-0-1-5";
import { SqliteInstanceWorkspacePolicyRepository } from "@linmu/dsh-session-store";
import type { RuntimeBrokerPrepareRunRequest } from "@linmu/dsh-session-contracts";
import { repairLegacyRuntimeWorkspace } from "../../../scripts/repair-legacy-runtime-workspace.js";
import { RuntimeWorkspaceRegistration } from "../src/runtime-workspace-registration.js";
import { createReadOnlyComposition } from "../src/composition-root.js";
import { createEngineFixture } from "./helpers.js";

it("repairs only the legacy empty registration and recovers RC2 WAL through the normal broker", async () => {
  const f = await createEngineFixture("legacy-workspace-upgrade"), at = "2026-09-20T00:00:00.000Z";
  let restarted: Awaited<ReturnType<typeof createReadOnlyComposition>> | undefined;
  let stopped = false;
  try {
    const request: RuntimeBrokerPrepareRunRequest = {
      schemaVersion: 1, client: { kind: "launcher", id: "fixture-launcher" }, runtimeClientId: "fixture-runtime",
      instanceId: "fixture-legacy", profileId: "web", dshVersion: "0.1.5-rc.2", maintenanceEndpoint: "http://127.0.0.1:41781",
      branchId: "main" as never, pinnedAdapterId: "dsh-0.1.5" as never, projectSelection: { kind: "all" },
      environment: { runtimeCapabilities: [...REQUIRED_CAPABILITIES], packageVersions: Object.fromEntries(
        ["@deepseek-ai/dsh-session", "@deepseek-ai/dsh-session-persistence", "@deepseek-ai/dsh-session-format-catalog"].map(p => [p, "0.1.5-rc.2"])) },
    };
    new SqliteInstanceWorkspacePolicyRepository(f.engine.repository.database).updatePolicy(request.instanceId, {
      expectedRevision: 0, selection: { kind: "ids", workspaceIds: [], includeUnassigned: false },
    });
    const run = await f.engine.prepareProjectionRuntimeRun(request);
    await f.engine.attachProjectionRuntimeRun({ schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId,
      temporaryPersistenceRootId: run.temporaryPersistenceRootId, attachedAt: at, nativeMode: run.nativeMode });
    const cwd = join(f.root, "original-project"); await mkdir(cwd);
    const nativeSessionId = "native-legacy" as never;
    const header = { version: 3, id: nativeSessionId, cwd, createdAt: Date.parse(at), isSeeded: false, agentPreset: "standard", delegationDepth: 0 };
    const legacy = vi.spyOn(RuntimeWorkspaceRegistration.prototype, "resolve").mockReturnValueOnce(null as never);
    const registered = await f.engine.registerProjectionRuntimeSession({ schemaVersion: 1, clientId: request.runtimeClientId,
      runId: run.runId, nativeSessionId, header, title: "Legacy first message" }); legacy.mockRestore();
    const events = [
      { type: "agent/inbox/spliced", seq: 0, time: Date.parse(at), data: { target: "next-turn", start: 0, inserted: [{ source: { kind: "user" }, content: [{ type: "text", text: "preserve this message" }], role: "user", id: "fixture-input" }] } },
      { type: "turn/start", seq: 1, time: Date.parse(at), data: { turn: 1 } },
    ];
    const operation = { runId: run.runId, nativeSessionId, operationId: "legacy-first-message" as never,
      nativeRevision: 2, observedAt: at, payload: { logicalSessionId: registered.logicalSessionId, instanceId: request.instanceId, header, inheritedEventCount: 0, events } };
    await expect(f.engine.appendProjectionRuntimeEvent(request.runtimeClientId, operation)).rejects.toMatchObject({ code: "SESSION_NOT_SYNCED" });
    const native = { header, inheritedEventCount: 0, events };
    const description = await v3NativeSessionCodec.describe(native, run.persistenceRoot), path = join(run.persistenceRoot, description.relativePath);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, v3NativeSessionCodec.encode(native, description));
    await expect(repairLegacyRuntimeWorkspace(f.engine, run.runId, registered.logicalSessionId as never)).rejects.toThrow("Restart Maintenance");
    await expect(f.engine.closeProjectionRuntimeRun({ schemaVersion: 1, clientId: request.client.id, runId: run.runId, reason: "recovery" })).rejects.toThrow();
    await f.stop(); stopped = true;
    restarted = await createReadOnlyComposition({ stateRoot: f.stateRoot, fixturePolicy: f.fixturePolicy });
    const repaired = await repairLegacyRuntimeWorkspace(restarted, run.runId, registered.logicalSessionId as never);
    expect(await repairLegacyRuntimeWorkspace(restarted, run.runId, registered.logicalSessionId as never)).toEqual(repaired);
    expect((await restarted.closeProjectionRuntimeRun({ schemaVersion: 1, clientId: request.client.id, runId: run.runId, reason: "recovery" })).state).toBe("recovered");
    const snapshot = await restarted.canonicalEngine.store.getSession(registered.logicalSessionId as never);
    expect(snapshot?.workspaceId).toBe(repaired.workspaceId);
    expect((await restarted.canonicalEngine.store.getVersion(snapshot!.headVersionId!))?.events).toHaveLength(2);
    expect(await restarted.projectionRunRepository.getOperationReceipt(operation.operationId)).toMatchObject({ status: "committed" });
    await expect(repairLegacyRuntimeWorkspace(restarted, run.runId, registered.logicalSessionId as never)).rejects.toThrow("failed run");
  } finally {
    vi.restoreAllMocks(); restarted?.close(); if (!stopped) await f.stop(); await f.cleanup();
  }
}, 30000);
