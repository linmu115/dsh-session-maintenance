import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { CanonicalEventV1, JsonValue, LogicalSessionId } from "@linmu/dsh-session-contracts";
import { readCanonicalConversationTopologyV1 } from "@linmu/dsh-session-contracts";
import { logicalSessionIdFor, sha256Canonical } from "@linmu/dsh-session-domain";
import { SqliteCanonicalRepository, SqliteAdapterEvidenceStore } from "@linmu/dsh-session-store";

import { CodexCanonicalImportService } from "../src/codex-canonical-import.js";
import {
  activateConversationTopologyRepairCandidate,
  previewConversationTopologyRepair,
  stageConversationTopologyRepair,
  type ConversationTopologyRepairStatus,
} from "../src/conversation-topology-repair.js";
import { SqliteCodexProjectPort } from "../src/sqlite-codex-project-port.js";
import { createEngineFixture, hashTree } from "./helpers.js";

const at = "2026-09-05T00:00:00.000Z";

function oldNativeSuffix(logicalSessionId: LogicalSessionId): CanonicalEventV1 {
  const raw = {
    type: "user/message",
    seq: 2,
    time: Date.parse(at),
    data: {
      id: "dsh-user-message",
      role: "user",
      content: [{ type: "text", text: "continued in DSH" }],
      source: { kind: "user" },
    },
    surfaceOp: "append",
  } as unknown as JsonValue;
  return {
    schemaVersion: 1,
    id: "old-dsh-native-suffix",
    logicalSessionId,
    sequence: 2,
    kind: "user-message",
    role: "user",
    content: (raw as { readonly data: JsonValue }).data,
    source: {
      platform: "dsh",
      instanceId: "dsh-rc1-old",
      sessionId: "native-old-derived",
      eventId: "2",
      cursor: "3",
    },
    contentDigest: sha256Canonical((raw as { readonly data: JsonValue }).data),
    rawPayload: raw,
    extensions: { dshEventType: "user/message" },
  };
}

describe("M06 RC1 conversation topology repair", () => {
  it("stages a candidate, preserves old versions and validates recomposed derived sessions", async () => {
    const fixture = await createEngineFixture("conversation-topology-repair");
    const sourceDatabasePath = join(fixture.stateRoot, "metadata.sqlite");
    const candidateFile = "metadata.m06-fixture.sqlite";
    const candidatePath = join(fixture.stateRoot, candidateFile);
    const instance = fixture.engine.instances.find((item) => item.platform === "codex")!;
    const canonicalRepository = new SqliteCanonicalRepository(fixture.engine.repository.database);
    const importer = new CodexCanonicalImportService({
      canonicalEngine: fixture.engine.canonicalEngine,
      projectPort: new SqliteCodexProjectPort(canonicalRepository),
      fixtureGuard: fixture.fixturePolicy,
      evidencePort: new SqliteAdapterEvidenceStore(
        fixture.engine.repository.database,
        fixture.engine.objectStore,
        { clock: () => at },
      ),
    });
    const sourceId = logicalSessionIdFor({
      platform: "codex",
      instanceId: instance.id,
      sessionId: "thread-fixture",
    }) as LogicalSessionId;
    const childId = "logical-m06-derived" as LogicalSessionId;
    const statuses: ConversationTopologyRepairStatus[] = [];

    try {
      await importer.sync({ instance });
      const retiredMirrorId = "logical-old-internal-codex" as LogicalSessionId;
      await fixture.engine.canonicalEngine.observeCodex({
        logicalSessionId: retiredMirrorId,
        title: "Old internal worker",
        tags: [],
        archivedAt: null,
        workspaceId: null,
        events: [{
          schemaVersion: 1,
          id: "old-internal-event",
          logicalSessionId: retiredMirrorId,
          sequence: 0,
          kind: "other",
          role: "unknown",
          content: {
            schemaVersion: 1,
            type: "other",
            reason: "unsupported-source-event",
            sourceKind: "codex/internal-worker",
            label: "old internal",
            summary: "old evidence",
            evidenceRef: null,
          },
          source: { platform: "codex", instanceId: instance.id, sessionId: "internal", eventId: "0", cursor: "0" },
          contentDigest: sha256Canonical("old evidence"),
          rawPayload: null,
          extensions: {},
        }],
        sourceCursor: "old-internal",
        observedAt: at,
      });
      const source = await fixture.engine.canonicalEngine.store.getSession(sourceId);
      expect(source?.headVersionId).not.toBeNull();
      await fixture.engine.projectionRunRepository.createProjectionRun({
        schemaVersion: 1,
        id: "run-old-derived" as never,
        leaseId: "lease-old-derived" as never,
        branchId: "branch-old-derived" as never,
        instanceId: "dsh-rc1-old",
        profileId: "fixture",
        dshVersion: "0.1.2-rc.1",
        adapterId: "dsh-rc1" as never,
        state: "closed",
        startedAt: at,
        heartbeatAt: at,
        checkpointId: null,
      });
      await fixture.engine.projectionRunRepository.upsertProjectionSession({
        schemaVersion: 1,
        runId: "run-old-derived" as never,
        nativeSessionId: "native-old-derived" as never,
        logicalSessionId: sourceId,
        baseVersionId: source!.headVersionId!,
        mode: "codex-read-until-write",
        nativeRevision: 2,
        lastCommittedOperationId: null,
        derivedChildSessionId: null,
      });
      await fixture.engine.canonicalEngine.appendDsh({
        logicalSessionId: sourceId,
        derivedLogicalSessionId: childId,
        baseVersionId: source!.headVersionId!,
        title: "ignored",
        tags: [],
        archivedAt: null,
        workspaceId: null,
        canonicalHistoryMode: "native",
        appendedEvents: [oldNativeSuffix(childId)],
        observedAt: at,
        projection: {
          runId: "run-old-derived" as never,
          leaseId: "lease-old-derived" as never,
          branchId: "branch-old-derived" as never,
          adapterId: "dsh-rc1" as never,
          nativeSessionId: "native-old-derived" as never,
          operationId: "operation-old-derived" as never,
          nativeRevision: 3,
        },
      });
      const oldChildHead = (await fixture.engine.canonicalEngine.store.getSession(childId))!.headVersionId!;
      const codexBefore = await hashTree(fixture.codexHome);
      const sourceHeadsBefore = fixture.engine.repository.database.prepare(
        "SELECT id, head_version_id FROM logical_sessions ORDER BY id",
      ).all();

      const preview = await previewConversationTopologyRepair({
        stateRoot: fixture.stateRoot,
        sourceDatabasePath,
        candidateFile,
        codexInstance: instance,
        fixtureGuard: fixture.fixturePolicy,
        onStatus: (event) => { statuses.push(event); },
      });
      expect(preview).toMatchObject({
        plannedCodexMirrors: 1,
        retriedCodexSessions: 0,
        existingCodexMirrors: 2,
        retiredCodexMirrors: 1,
        derivedSessionsToRecompose: 1,
        candidateExists: false,
      });
      expect(fixture.engine.repository.database.prepare(
        "SELECT id, head_version_id FROM logical_sessions ORDER BY id",
      ).all()).toEqual(sourceHeadsBefore);

      const manifest = await stageConversationTopologyRepair({
        stateRoot: fixture.stateRoot,
        sourceDatabasePath,
        candidateFile,
        codexInstance: instance,
        fixtureGuard: fixture.fixturePolicy,
        expectedSourceDigest: preview.sourceDigest,
        expectedCodexPlanDigest: preview.codexPlanDigest,
        now: () => at,
        onStatus: (event) => { statuses.push(event); },
      });
      expect(manifest).toMatchObject({
        recomposedDerivedSessions: 1,
        retiredCodexMirrors: 1,
        verifiedRc1Sessions: 2,
        integrityCheck: "ok",
        foreignKeyViolations: 0,
      });
      expect(await hashTree(fixture.codexHome)).toBe(codexBefore);
      expect(fixture.engine.repository.database.prepare(
        "SELECT id, head_version_id FROM logical_sessions ORDER BY id",
      ).all()).toEqual(sourceHeadsBefore);

      const candidate = new DatabaseSync(candidatePath, { readOnly: true });
      try {
        const childHeadRow = candidate.prepare(
          "SELECT head_version_id FROM logical_sessions WHERE id = ?",
        ).get(childId) as { readonly head_version_id: string };
        expect(childHeadRow.head_version_id).not.toBe(oldChildHead);
        expect(candidate.prepare("SELECT COUNT(*) AS count FROM session_versions WHERE id = ?").get(oldChildHead))
          .toEqual({ count: 1 });
        expect(candidate.prepare("SELECT COUNT(*) AS count FROM checkpoints WHERE id = ?").get(manifest.checkpointId))
          .toEqual({ count: 1 });
        expect(candidate.prepare("SELECT tombstoned_at FROM logical_sessions WHERE id = ?").get(retiredMirrorId))
          .toEqual({ tombstoned_at: at });
      } finally {
        candidate.close();
      }

      const candidateStore = new (await import("@linmu/dsh-session-store")).SqliteCanonicalSessionEngineStore(
        new DatabaseSync(candidatePath, { readOnly: true }),
        fixture.engine.objectStore,
      );
      try {
        const child = await candidateStore.getSession(childId);
        const head = await candidateStore.getVersion(child!.headVersionId!);
        const suffix = head!.events.find((event) => event.id === "old-dsh-native-suffix")!;
        expect(suffix.rawPayload).toBeNull();
        expect(suffix.extensions.portableFromRc1).toBe(true);
        expect(readCanonicalConversationTopologyV1(suffix)).not.toBeNull();
      } finally {
        candidateStore.database.close();
      }

      let activated: string | undefined;
      await expect(activateConversationTopologyRepairCandidate({
        stateRoot: fixture.stateRoot,
        sourceDatabasePath,
        candidateFile,
        expectedSourceDigest: preview.sourceDigest,
        expectedCandidateDigest: manifest.candidateDigest,
        activateDatabaseFile: async (file) => { activated = file; },
      })).resolves.toEqual({ activeDatabaseFile: candidateFile, restartRequired: true });
      expect(activated).toBe(candidateFile);
      expect(statuses.map((event) => `${event.stage}:${event.state}`)).toEqual(expect.arrayContaining([
        "repair.preview:succeeded",
        "repair.checkpoint:succeeded",
        "repair.codex-plan:succeeded",
        "repair.mirror-write:succeeded",
        "repair.derived-recompose:succeeded",
        "repair.rc1-verify:succeeded",
        "repair.candidate-ready:succeeded",
      ]));
    } finally {
      await fixture.cleanupAll();
    }
  }, 30_000);
});
