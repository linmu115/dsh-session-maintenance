import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CanonicalSessionEngine } from "@linmu/dsh-canonical-session-engine";
import type { CanonicalEventV1, LogicalSessionId } from "@linmu/dsh-session-contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  openMaintenanceDatabase,
  SqliteCanonicalSessionEngineStore,
  ZstdContentObjectStore,
} from "../src/index.js";

const roots: string[] = [];
const databases: ReturnType<typeof openMaintenanceDatabase>[] = [];
const at = "2026-09-01T00:00:00.000Z";

function event(id: string, logicalSessionId: LogicalSessionId, sequence: number, platform: "codex" | "dsh"): CanonicalEventV1 {
  return {
    schemaVersion: 1,
    id,
    logicalSessionId,
    sequence,
    kind: platform === "codex" ? "user-message" : "assistant-message",
    role: platform === "codex" ? "user" : "assistant",
    content: { text: id },
    source: { platform, instanceId: `${platform}-fixture`, sessionId: "native", eventId: id, cursor: String(sequence) },
    contentDigest: `sha256:${id}`,
    rawPayload: null,
    extensions: {},
  };
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SQLite canonical engine store", () => {
  it("persists a Codex head then atomically creates the first DSH-derived child", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-canonical-store-"));
    roots.push(root);
    const database = openMaintenanceDatabase(join(root, "metadata.sqlite"));
    databases.push(database);
    const store = new SqliteCanonicalSessionEngineStore(database, new ZstdContentObjectStore(root));
    const engine = new CanonicalSessionEngine(store);
    const parentId = "logical-codex" as LogicalSessionId;
    const childId = "logical-derived" as LogicalSessionId;
    const observed = await engine.observeCodex({
      logicalSessionId: parentId,
      title: "Codex source",
      tags: [],
      archivedAt: null,
      workspaceId: null,
      events: [event("event-parent", parentId, 0, "codex")],
      sourceCursor: "1",
      observedAt: at,
    });
    expect(observed.outcome).toBe("created");
    expect(observed.versionId).not.toBeNull();

    database.prepare(
      `INSERT INTO adapter_registrations
        (adapter_id, manifest_json, package_location, enabled, registered_at, updated_at)
       VALUES ('adapter-alpha2', '{}', 'fixture', 1, ?, ?)`,
    ).run(at, at);
    database.prepare(
      `INSERT INTO projection_runs
        (id, lease_id, branch_id, instance_id, profile_id, dsh_version, adapter_id,
         state, started_at, heartbeat_at, checkpoint_id)
       VALUES ('run-1', 'lease-1', 'main', 'dsh-alpha2', 'alpha2', '0.1.2-alpha.2',
               'adapter-alpha2', 'running', ?, ?, NULL)`,
    ).run(at, at);
    database.prepare(
      `INSERT INTO projection_sessions
        (run_id, native_session_id, logical_session_id, base_version_id, mode,
         native_revision, last_committed_operation_id, derived_child_session_id)
       VALUES ('run-1', 'native-1', ?, ?, 'codex-read-until-write', 1, NULL, NULL)`,
    ).run(parentId, observed.versionId);

    const receipt = await engine.appendDsh({
      logicalSessionId: parentId,
      derivedLogicalSessionId: childId,
      baseVersionId: observed.versionId!,
      title: "ignored current title",
      tags: [],
      archivedAt: null,
      workspaceId: null,
      appendedEvents: [event("event-child", parentId, 1, "dsh")],
      observedAt: "2026-09-01T00:00:01.000Z",
      projection: {
        runId: "run-1" as never,
        leaseId: "lease-1" as never,
        branchId: "main" as never,
        adapterId: "adapter-alpha2" as never,
        nativeSessionId: "native-1" as never,
        operationId: "operation-1" as never,
        nativeRevision: 2,
      },
    });

    expect(receipt).toMatchObject({ outcome: "derived", logicalSessionId: childId });
    expect((await store.getSession(childId))?.session).toMatchObject({
      authorityScope: "maintenance",
      originKind: "codex-derived",
      headVersionId: receipt.versionId,
    });
    expect((await store.getVersion(receipt.versionId!))?.events.map((item) => item.id)).toEqual([
      "event-parent",
      "event-child",
    ]);
    expect(await store.getOperationReceipt("operation-1" as never)).toEqual(receipt);
  });
});
