import { describe, expect, it } from "vitest";
import type { CanonicalProjectionSessionInput, JsonValue } from "@linmu/dsh-session-adapter-sdk";

import { adapter, rc1NativeSessionId, rc1ProjectedNativeRevision } from "../src/index.js";

const at = "2026-09-01T00:00:00.000Z";

describe("Rc1 projected native revision", () => {
  it("counts expanded native events instead of packed canonical storage rows", async () => {
    const logicalSessionId = "logical-packed-revision" as never;
    const canonical: CanonicalProjectionSessionInput = {
      session: {
        schemaVersion: 1,
        id: logicalSessionId,
        authorityScope: "maintenance",
        originKind: "maintenance-native",
        headVersionId: null,
        title: "Packed revision",
        tags: [],
        archivedAt: null,
        tombstonedAt: null,
        createdAt: at,
        updatedAt: at,
      },
      events: [{
        schemaVersion: 1,
        id: "event-packed-revision",
        logicalSessionId,
        sequence: 0,
        kind: "opaque-unknown",
        role: "unknown",
        content: { turn: 0, step: 0, index: 0, dt: [1, 2], texts: ["a", "b", "c"] },
        source: { platform: "dsh", instanceId: "fixture", sessionId: "source", eventId: "0", cursor: "2" },
        contentDigest: "sha256:packed-revision",
        rawPayload: {
          type: "text-chunks",
          seq: 0,
          time: Date.parse(at),
          data: { turn: 0, step: 0, index: 0, dt: [1, 2], texts: ["a", "b", "c"] },
        },
        extensions: { heldOut: true },
      }],
      workspaceId: null,
    };
    const sessions = new Map<string, JsonValue>();
    await adapter.materialize({
      run: {
        schemaVersion: 1,
        id: "run-packed-revision" as never,
        leaseId: "lease-packed-revision" as never,
        branchId: "main" as never,
        instanceId: "rc1",
        profileId: "web",
        dshVersion: "0.1.2-rc.1",
        adapterId: adapter.manifest.id,
        state: "preparing",
        startedAt: at,
        heartbeatAt: at,
        checkpointId: null,
      },
      workspaces: [],
      sessions: [canonical],
    }, {
      writeWorkspace: async () => undefined,
      writeSession: async (id, payload) => { sessions.set(id, payload); },
    });
    const payload = sessions.get(rc1NativeSessionId(logicalSessionId))!;

    expect(canonical.events).toHaveLength(1);
    expect(rc1ProjectedNativeRevision(canonical, payload)).toBe(3);
    expect(adapter.projectedNativeRevision?.(canonical, payload)).toBe(3);
  });
});
