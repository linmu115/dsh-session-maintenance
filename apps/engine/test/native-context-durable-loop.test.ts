import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { REQUIRED_CAPABILITIES, verifyV3NativeContextMaterials, verifyV3NativeContextRelease } from "@linmu/dsh-session-adapter-0-1-5";
import type { NativeContextMaterialInput, RuntimeBrokerPrepareRunRequest } from "@linmu/dsh-session-contracts";
import { createEngineFixture, hashTree, joinInstanceWorkspace } from "./helpers.js";

const at = "2026-09-15T00:00:00Z";
const producerFixture = async () => JSON.parse(await readFile(new URL("./fixtures/native-context-core-agent-loop.json", import.meta.url), "utf8")) as {
  payload: any; materials: NativeContextMaterialInput[];
  operation: { operationId: string; materialIds: string[] };
  receipt: { surfaceEventSeqs: number[]; sourceEventSeqs: number[]; releasedBytes: number };
};

describe("actual Core AgentLoop producer through durable Maintenance receipts", () => {
  it("verifies the real producer's native output and byte calculation without a model or provider request", async () => {
    const fixture = await producerFixture(), nativeSessionId = fixture.payload.header.id;
    expect(verifyV3NativeContextMaterials(fixture.payload, { nativeSessionId, materials: fixture.materials })).toEqual(fixture.materials);
    const proof = verifyV3NativeContextRelease(fixture.payload, { nativeSessionId, operationId: fixture.operation.operationId,
      materials: fixture.materials.filter(item => fixture.operation.materialIds.includes(item.materialId)),
      surfaceEventSeqs: fixture.receipt.surfaceEventSeqs, sourceEventSeqs: fixture.receipt.sourceEventSeqs });
    expect(proof.releasedBytes).toBe(fixture.receipt.releasedBytes);
    expect(proof.surfaceEventSeqs).toEqual(fixture.receipt.surfaceEventSeqs);
    expect(proof.surfaceEventSeqs.length).toBeGreaterThan(0);
  });

  it("refuses applied before durable replacement, accepts after append, and derives its own receipt bytes", async () => {
    const fixture = await producerFixture(), f = await createEngineFixture("native-context-durable-loop");
    const beforeHomes = await Promise.all([hashTree(f.codexHome), hashTree(f.dshHome)]);
    try {
      const request: RuntimeBrokerPrepareRunRequest = { schemaVersion: 1, client: { kind: "launcher", id: "fixture-launcher" }, runtimeClientId: "fixture-runtime",
        instanceId: "fixture-native-loop", profileId: "web", dshVersion: "0.1.5-rc.2", maintenanceEndpoint: "http://127.0.0.1:41781",
        branchId: "main" as never, pinnedAdapterId: "dsh-0.1.5" as never, projectSelection: { kind: "all" }, environment: { runtimeCapabilities: [...REQUIRED_CAPABILITIES],
          packageVersions: Object.fromEntries(["@deepseek-ai/dsh-session", "@deepseek-ai/dsh-session-persistence", "@deepseek-ai/dsh-session-format-catalog"].map(p => [p, "0.1.5-rc.2"])) } };
      await joinInstanceWorkspace(f.engine, { instanceId: request.instanceId, cwd: f.root });
      const run = await f.engine.prepareProjectionRuntimeRun(request);
      await f.engine.attachProjectionRuntimeRun({ schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId,
        temporaryPersistenceRootId: run.temporaryPersistenceRootId, attachedAt: at, nativeMode: run.nativeMode });
      const nativeSessionId = fixture.payload.header.id;
      const header = { ...fixture.payload.header, cwd: f.root };
      const registered = await f.engine.registerProjectionRuntimeSession({ schemaVersion: 1, clientId: request.runtimeClientId,
        runId: run.runId, nativeSessionId, header, title: "Synthetic native context execution" });
      const append = (events: any[], operationId: string) => f.engine.appendProjectionRuntimeEvent(request.runtimeClientId, {
        runId: run.runId, nativeSessionId, operationId: operationId as never, nativeRevision: events.at(-1).seq + 1, observedAt: at,
        payload: { logicalSessionId: registered.logicalSessionId, instanceId: request.instanceId, header, inheritedEventCount: 0, events } });
      const firstReplacement = Math.min(...fixture.receipt.surfaceEventSeqs);
      expect((await append(fixture.payload.events.slice(0, firstReplacement), "native-loop-prefix")).status).toBe("committed");
      f.engine.extensions!.connect({ instanceId: request.instanceId, profileId: "web", plugins: [
        { namespace: "annotation-upstream", pluginVersion: "0.3.12-rc2.12", writerId: "dsh-annotation-core" },
        { namespace: "annotation-context", pluginVersion: "0.3.12-rc2.12", writerId: "dsh-annotation-core" },
      ] });
      const scope = { runId: run.runId, targetNativeSessionId: nativeSessionId, executionId: "synthetic-native-loop", actor: "host" as const };
      const materials = await f.engine.nativeContext.registerMaterials({ ...scope, materials: fixture.materials });
      const pending = await f.engine.nativeContext.release({ ...scope, actor: "model", operationId: fixture.operation.operationId,
        expectedRevision: materials.revision, materialIds: fixture.operation.materialIds, reason: "Release the used answer" });
      expect(pending.operations.at(-1)!.state).toBe("pending-next-step");
      const receipt = { ...scope, operationId: fixture.operation.operationId, state: "applied", sourceEventSeqs: fixture.receipt.sourceEventSeqs,
        surfaceEventSeqs: fixture.receipt.surfaceEventSeqs, releasedBytes: 999999 };
      await expect(f.engine.nativeContext.receipt(receipt)).rejects.toThrow("applied replacement");
      expect((await f.engine.nativeContext.status(scope)).operations.at(-1)!.state).toBe("pending-next-step");
      expect((await append(fixture.payload.events.slice(firstReplacement), "native-loop-replacement")).status).toBe("committed");
      const canonicalBefore = await f.engine.canonicalEngine.store.getSession(registered.logicalSessionId as never);
      const applied = await f.engine.nativeContext.receipt(receipt);
      expect(applied.operations.at(-1)).toMatchObject({ state: "applied", releasedBytes: fixture.receipt.releasedBytes,
        sourceEventSeqs: fixture.receipt.sourceEventSeqs, surfaceEventSeqs: fixture.receipt.surfaceEventSeqs });
      expect(applied.operations.at(-1)!.releasedBytes).not.toBe(receipt.releasedBytes);
      expect(applied.materials.find(item => fixture.operation.materialIds.includes(item.materialId))!.state).toBe("released");
      expect(applied.materials.filter(item => !fixture.operation.materialIds.includes(item.materialId)).every(item => item.state === "retained")).toBe(true);
      const repeated = await f.engine.nativeContext.receipt(receipt);
      expect(repeated.revision).toBe(applied.revision);
      const canonicalAfter = await f.engine.canonicalEngine.store.getSession(registered.logicalSessionId as never);
      expect(canonicalAfter!.headVersionId).toBe(canonicalBefore!.headVersionId);
      const version = await f.engine.canonicalEngine.store.getVersion(canonicalAfter!.headVersionId!);
      expect(version!.events[0]!.content).toEqual(fixture.payload.events[0].data);
      expect(await Promise.all([hashTree(f.codexHome), hashTree(f.dshHome)])).toEqual(beforeHomes);
    } finally { await f.cleanupAll(); }
  }, 30000);
});
