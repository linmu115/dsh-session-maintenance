import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { constants, zstdCompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { JsonProjectionDirectory } from "@linmu/dsh-session-projection-lifecycle";
import { SqliteAdapterEvidenceStore } from "@linmu/dsh-session-store";
import { createReadOnlyComposition } from "../src/composition-root.js";
import { SqliteRuntimeProjectResolver } from "../src/runtime-project-resolver.js";
import { createEngineFixture, hashTree } from "./helpers.js";

describe("repair of an RC1 session rejected before canonical registration", () => {
  it("finishes the existing registration recovery and keeps every durable control/inbox row", async () => {
    const f = await createEngineFixture("runtime-unregistered-recovery");
    let reopened: Awaited<ReturnType<typeof createReadOnlyComposition>> | undefined;
    let stopped = false;
    try {
      const request = { schemaVersion: 1 as const, client: { kind: "launcher" as const, id: "fixture-repair-launcher" }, runtimeClientId: "fixture-repair-runtime", instanceId: "fixture-rc1", profileId: "web", dshVersion: "0.1.2-rc.1", maintenanceEndpoint: "http://127.0.0.1:41781", branchId: "main" as never, pinnedAdapterId: "dsh-rc1" as never, projectSelection: { kind: "all" as const }, environment: { packageVersions: { "@deepseek-ai/dsh-session": "0.1.2-rc.1", "@deepseek-ai/dsh-session-persistence": "0.1.2-rc.1" }, runtimeCapabilities: ["sessionPersistence", "session/event", "session/flush"] } };
      const run = await f.engine.prepareProjectionRuntimeRun(request);
      const cwd = "D:/synthetic/new-workspace";
      const nativeId = "session-failed-registration";
      const createdAt = Date.parse("2026-09-07T00:00:00.000Z");
      const header = { version: 0, id: nativeId, cwd, createdAt, delegationDepth: 0, agentPreset: "standard", isSeeded: false };
      const rows = [
        { type: "permission/preset", data: { preset: "default" } },
        { type: "sandbox/mode", data: { mode: "workspace-write" } },
        { type: "approval/policy", data: { policy: "never" } },
        { type: "agent/inbox/spliced", data: { target: "main", start: 0, inserted: [{ id: "fixture-draft", role: "user", content: [{ type: "text", text: "original fixture draft" }], source: { kind: "user" } }] } },
        { type: "turn/start", data: { turn: 1 } },
        { type: "agent/inbox/spliced", data: { target: "main", start: 0, removedCount: 1, inserted: [] } },
        { type: "turn/end", data: { turn: 1, reason: { kind: "failed", message: "no canonical project root" } } },
      ].map((row, seq) => ({ ...row, seq, time: createdAt + seq }));
      const nativeDir = join(run.persistenceRoot, "--D-synthetic-new-workspace--", nativeId);
      await mkdir(nativeDir, { recursive: true });
      const { isSeeded: _, ...storageHeader } = header;
      await writeFile(join(nativeDir, "session.jsonl.zstd"), Buffer.concat([
        zstdCompressSync(Buffer.from(JSON.stringify({ type: "session", ...storageHeader }) + "\n"), { params: { [constants.ZSTD_c_checksumFlag]: 1 } }),
        zstdCompressSync(Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n"), { params: { [constants.ZSTD_c_checksumFlag]: 1 } }),
      ]));
      await f.engine.attachProjectionRuntimeRun({ schemaVersion: 1, clientId: request.runtimeClientId, runId: run.runId, temporaryPersistenceRootId: run.temporaryPersistenceRootId, attachedAt: new Date(createdAt).toISOString() });
      await expect(f.engine.closeProjectionRuntimeRun({ schemaVersion: 1, clientId: request.client.id, runId: run.runId, reason: "recovery" })).rejects.toThrow("No committed mapping exists");
      const sourceHash = await hashTree(f.codexHome);
      await f.stop();
      stopped = true;
      reopened = await createReadOnlyComposition({ stateRoot: f.stateRoot, fixturePolicy: f.fixturePolicy });
      const logicalId = `logical-dsh-${createHash("sha256").update(`${request.instanceId}\0${nativeId}`).digest("hex").slice(0, 32)}`;
      await reopened.runWrite("fixture-registration-repair", async () => {
        const projectId = await new SqliteRuntimeProjectResolver(reopened!.repository.database).ensureLocalProject(cwd);
        const directory = new JsonProjectionDirectory(dirname(run.persistenceRoot));
        await directory.writeSession(nativeId as never, { schemaVersion: 1, logicalSessionId: logicalId, baseVersionId: null, workspaceId: null, projectId, updatedAt: new Date(createdAt).toISOString(), title: "new-workspace", tags: [], inheritedEventCount: 0, header, events: [] });
        await directory.rebuildSessionCatalog(run.runId);
      });
      await expect(reopened.closeProjectionRuntimeRun({ schemaVersion: 1, clientId: request.client.id, runId: run.runId, reason: "recovery" })).resolves.toMatchObject({ state: "recovered", removedProjection: true });
      expect(reopened.repository.database.prepare("SELECT origin_kind,authority_scope,tombstoned_at FROM logical_sessions WHERE id=?").get(logicalId)).toEqual({ origin_kind: "maintenance-native", authority_scope: "maintenance", tombstoned_at: null });
      const next = await reopened.prepareProjectionRuntimeRun(request);
      try {
        const mapped = (await reopened.projectionRunRepository.listProjectionSessions(next.runId)).find(session => session.logicalSessionId === logicalId)!;
        const payload = await new JsonProjectionDirectory(dirname(next.persistenceRoot)).readSession(mapped.nativeSessionId) as { events: Array<{ type: string; data: { canonicalContent?: { evidenceRef: string } } }> };
        expect(payload.events).toHaveLength(rows.length);
        const evidence = new SqliteAdapterEvidenceStore(reopened.repository.database, reopened.objectStore);
        for (const [index, row] of rows.entries()) {
          const projected = payload.events[index]!;
          if (projected.type === "maintenance/other") {
            expect((await evidence.readEvidence(projected.data.canonicalContent!.evidenceRef as never, "dsh-rc1" as never))?.payload).toEqual(row);
          } else { expect(projected).toEqual(row); }
        }
      } finally { await reopened.closeProjectionRuntimeRun({ schemaVersion: 1, clientId: request.client.id, runId: next.runId, reason: "recovery" }); }
      expect(await hashTree(f.codexHome)).toBe(sourceHash);
    } finally { reopened?.close(); if (stopped) await f.cleanup(); else await f.cleanupAll(); }
  });
});
