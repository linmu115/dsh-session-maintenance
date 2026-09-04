import { afterEach, describe, expect, it } from "vitest";

import { adapter } from "../../packages/adapter-dsh-alpha2/src/index.js";
import {
  SqliteCanonicalRepository,
  SqliteProjectionRunRepository,
  SqliteSessionAliasRepository,
} from "../../packages/session-store/src/index.js";
import { resolveMaintenanceLogicalLocation } from "../../plugins/dsh-session-maintenance/src/client/session-locator.js";
import { createEngineFixture } from "../../apps/engine/test/helpers.js";

const cleanups: Array<() => Promise<void>> = [];
const at = "2026-08-31T00:00:00.000Z";

afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("logical reference round trip", () => {
  it("resolves logical and legacy links against the active projection without logging body text", async () => {
    const fixture = await createEngineFixture("reference-roundtrip");
    cleanups.push(fixture.cleanupAll);
    const logicalSessionId = "logical-reference-roundtrip" as never;
    const nativeSessionId = "session-alpha2-current" as never;
    const runId = "run-reference-roundtrip" as never;
    const canonical = new SqliteCanonicalRepository(fixture.engine.repository.database);
    await canonical.createCanonicalSession({
      schemaVersion: 1,
      id: logicalSessionId,
      authorityScope: "maintenance",
      originKind: "maintenance-native",
      headVersionId: null,
      title: "Synthetic reference fixture",
      tags: [],
      archivedAt: null,
      tombstonedAt: null,
      createdAt: at,
      updatedAt: at,
    });
    fixture.engine.repository.database.prepare(
      `INSERT INTO platform_bindings
        (id, logical_session_id, platform, instance_id, session_id, adapter_contract_json,
         last_common_version_id, status)
       VALUES (?, ?, 'codex', ?, ?, ?, NULL, 'read-only')`,
    ).run(
      "binding-reference-roundtrip",
      logicalSessionId,
      "codex-local",
      "codex-thread-reference-roundtrip",
      JSON.stringify({ adapter: "adapter-codex-read", platformVersion: "1", schemaFingerprint: "codex-v1" }),
    );
    const runs = new SqliteProjectionRunRepository(fixture.engine.repository.database);
    await runs.createProjectionRun({
      schemaVersion: 1,
      id: runId,
      leaseId: "lease-reference-roundtrip" as never,
      branchId: "main" as never,
      instanceId: "alpha2-reference-fixture",
      profileId: "alpha2-stable",
      dshVersion: "0.1.2-alpha.2",
      adapterId: adapter.manifest.id,
      state: "running",
      startedAt: at,
      heartbeatAt: at,
      checkpointId: null,
    });
    await runs.upsertProjectionSession({
      schemaVersion: 1,
      runId,
      nativeSessionId,
      logicalSessionId,
      baseVersionId: null,
      mode: "maintenance-write",
      nativeRevision: 0,
      lastCommittedOperationId: null,
      derivedChildSessionId: null,
    });
    await new SqliteSessionAliasRepository(fixture.engine.repository.database).upsert({
      aliasKind: "legacy-reference",
      instanceId: "alpha1-historical-profile",
      nativeId: "session-alpha1-old",
      target: { logicalSessionId, logicalWorkspaceId: null },
      createdAt: at,
      lastSeenAt: at,
    });

    const server = await fixture.startServer();
    const detailResponse = await fetch(`${server.origin}/v1/canonical/sessions/${logicalSessionId}`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json() as {
      readonly session: { readonly nativeReferences: { readonly references: readonly Array<{ readonly referenceUse: string; readonly nativeSessionId: string }> } };
    };
    expect(detail.session.nativeReferences.references.map((reference) => [reference.referenceUse, reference.nativeSessionId])).toEqual([
      ["source", "codex-thread-reference-roundtrip"],
      ["active-projection", nativeSessionId],
      ["historical-alias", "session-alpha1-old"],
    ]);
    const logical = await resolveMaintenanceLogicalLocation({
      endpoint: server.origin,
      authorization: `Bearer ${server.token}`,
      location: {
        referenceType: "annotation",
        logicalSessionId,
        logicalAnchorId: "logical-anchor-1",
        legacyNativeSessionId: null,
        legacyNativeAnchorId: null,
      },
    });
    expect(logical).toEqual({ sessionId: nativeSessionId, anchorId: "logical-anchor-1" });

    const legacyResponse = await fetch(`${server.origin}/v1/references/resolve`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        referenceType: "sticker",
        logicalSessionId: null,
        logicalAnchorId: null,
        legacyNativeSessionId: "session-alpha1-old",
        legacyNativeAnchorId: "legacy-anchor-1",
      }),
    });
    expect(legacyResponse.status).toBe(200);
    expect(await legacyResponse.json()).toEqual({
      resolution: {
        referenceType: "sticker",
        logicalSessionId,
        logicalAnchorId: null,
        nativeSessionId,
        nativeAnchorId: "legacy-anchor-1",
        runId,
        status: "resolved",
      },
    });

    const status = await fixture.engine.listStatusEvents({ runId, stage: "reference.roundtrip.verify" });
    expect(status.items.map((event) => `${event.state}:${event.diagnosticDetailRef}`)).toEqual([
      "started:diag:reference-annotation-resolved",
      "succeeded:diag:reference-annotation-resolved",
      "started:diag:reference-sticker-resolved",
      "succeeded:diag:reference-sticker-resolved",
    ]);
    expect(JSON.stringify(status.items)).not.toContain("Synthetic reference fixture");
    const indexStatus = await fixture.engine.listStatusEvents({ runId, stage: "reference.index" });
    expect(indexStatus.items.map((event) => `${event.state}:${event.diagnosticDetailRef}`)).toEqual([
      "started:diag:reference-index-annotation-resolved",
      "succeeded:diag:reference-index-annotation-resolved",
      "started:diag:reference-index-sticker-resolved",
      "succeeded:diag:reference-index-sticker-resolved",
    ]);
    expect(JSON.stringify(indexStatus.items)).not.toContain("Synthetic reference fixture");

    await runs.setProjectionRunState(runId, "closed");
    expect(await fixture.engine.resolveStableReference({
      referenceType: "obsidian-reference",
      logicalSessionId,
      logicalAnchorId: "logical-anchor-1",
      legacyNativeSessionId: null,
      legacyNativeAnchorId: null,
    })).toMatchObject({ status: "unavailable", nativeSessionId: null, runId: null });
  });
});
