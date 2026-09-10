import { appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { constants, zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { JsonValue, RuntimeBrokerPrepareRunRequest } from "@linmu/dsh-session-contracts";
import { rc1NativeSessionCodec } from "../../../packages/adapter-dsh-rc1/src/index.js";
import { createReadOnlyComposition } from "../src/composition-root.js";
import { createEngineFixture } from "./helpers.js";

const at = "2026-09-10T00:00:00.000Z";
const request: RuntimeBrokerPrepareRunRequest = {
  schemaVersion: 1, client: { kind: "launcher", id: "fixture-native-launcher" }, runtimeClientId: "fixture-native-runtime",
  instanceId: "fixture-native-rc1", profileId: "web", dshVersion: "0.1.2-rc.1", maintenanceEndpoint: "http://127.0.0.1:41781",
  branchId: "main" as never, pinnedAdapterId: "dsh-rc1" as never, projectSelection: { kind: "all" },
  environment: { packageVersions: { "@deepseek-ai/dsh-session": "0.1.2-rc.1", "@deepseek-ai/dsh-session-persistence": "0.1.2-rc.1" },
    runtimeCapabilities: ["sessionPersistence", "session/event", "session/flush"] },
};
const event = (seq: number): JsonValue => ({ seq, time: Date.parse(at) + seq, type: "user/message", surfaceOp: "append",
  data: { id: `synthetic-message-${seq}`, role: "user", content: [{ type: "text", text: `synthetic ${seq}` }], source: { kind: "user" } } });

describe("persistent native Broker lifecycle", () => {
  it.each(["normal", "crash-attached", "crash-before-attach"])("N06/N07/N12/N13: %s preserves the tail exactly once", async mode => {
    const f = await createEngineFixture(`persistent-native-${mode}`);
    let engine = f.engine;
    let stopped = false;
    try {
      await engine.runWrite("synthetic-initial", () => engine.canonicalEngine.importDshNative({
        operationId: "synthetic-import" as never, logicalSessionId: "synthetic-logical" as never, nativeSessionId: "synthetic-source" as never,
        title: "Synthetic native history", tags: ["fixture"], archivedAt: null, workspaceId: null, events: [], importedAt: at,
      }));
      const run = await engine.prepareProjectionRuntimeRun(request);
      expect(run.nativeMode).toBe("persistent-native-v1");
      expect(run.controlRoot).not.toBe(join(run.persistenceRoot, ".."));
      const mappings = await engine.projectionRunRepository.listProjectionSessions(run.runId);
      const mapped = mappings.find(s => s.logicalSessionId === "synthetic-logical")!;
      const initial = (await rc1NativeSessionCodec.inspect(run.persistenceRoot)).find(s => s.nativeSessionId === mapped.nativeSessionId)!;
      const path = join(run.persistenceRoot, initial.relativePath);
      const seq = initial.events.length;
      const tail = event(seq);
      const ack = { schemaVersion: 1 as const, clientId: request.runtimeClientId, runId: run.runId,
        temporaryPersistenceRootId: run.temporaryPersistenceRootId, attachedAt: at };
      await expect(engine.attachProjectionRuntimeRun(ack)).rejects.toThrow(/must acknowledge/);
      if (mode !== "crash-before-attach") await engine.attachProjectionRuntimeRun({ ...ack, nativeMode: run.nativeMode });
      await appendFile(path, zstdCompressSync(Buffer.from(`${JSON.stringify(tail)}\n`), { params: { [constants.ZSTD_c_checksumFlag]: 1 } }));
      if (mode === "normal") {
        const op = { runId: run.runId, nativeSessionId: mapped.nativeSessionId, operationId: "synthetic-tail" as never,
          nativeRevision: seq + 1, observedAt: at, payload: { logicalSessionId: mapped.logicalSessionId, canonicalHistoryMode: "native", events: [tail] } };
        expect((await engine.appendProjectionRuntimeEvent(request.runtimeClientId, op)).status).toBe("committed");
        await engine.appendProjectionRuntimeEvent(request.runtimeClientId, op);
        await engine.drainProjectionRuntimeRun({ schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId, runtimeFlushCompletedAt: at });
      } else {
        await f.stop(); stopped = true;
        engine = await createReadOnlyComposition({ stateRoot: f.stateRoot, fixturePolicy: f.fixturePolicy });
      }
      await engine.closeProjectionRuntimeRun({ schemaVersion: 1, clientId: request.client.id, runId: run.runId, reason: mode === "normal" ? "normal" : "recovery" });
      const before = await readFile(path); const mtime = (await stat(path, { bigint: true })).mtimeNs;
      const next = await engine.prepareProjectionRuntimeRun(request);
      expect(next.persistenceRoot).toBe(run.persistenceRoot);
      const loaded = (await rc1NativeSessionCodec.inspect(next.persistenceRoot)).find(s => s.nativeSessionId === mapped.nativeSessionId)!;
      expect(loaded.events).toEqual([...initial.events, tail]);
      expect(await readFile(path)).toEqual(before);
      expect((await stat(path, { bigint: true })).mtimeNs).toBe(mtime);
      await engine.closeProjectionRuntimeRun({ schemaVersion: 1, clientId: request.client.id, runId: next.runId, reason: "recovery" });
    } finally { if (stopped) { engine.close(); await f.cleanup(); } else await f.cleanupAll(); }
  }, 60_000);
});
