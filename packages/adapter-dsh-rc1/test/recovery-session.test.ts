import { describe, expect, it } from "vitest";

import { recoverRc1ProjectionSession } from "../src/recovery-session.js";

describe("recoverRc1ProjectionSession", () => {
  it("uses the committed projection watermark and preserves project/workspace separation", () => {
    const recovered = recoverRc1ProjectionSession({
      schemaVersion: 1,
      runId: "run-test",
      nativeSessionId: "native-test",
      logicalSessionId: "logical-test",
      baseVersionId: null,
      mode: "maintenance-write",
      nativeRevision: 1,
      lastCommittedOperationId: null,
      derivedChildSessionId: null,
    } as never, {
      schemaVersion: 1,
      logicalSessionId: "logical-test",
      projectId: "project-test",
      workspaceId: "workspace-test",
      title: "Recovered",
      tags: ["rc1"],
      inheritedEventCount: 0,
      header: { version: 0, id: "native-test", createdAt: 1, cwd: "D:/Project", isSeeded: false },
      events: [{ seq: 0 }, { seq: 1 }],
    });

    expect(recovered).toMatchObject({
      projectId: "project-test",
      workspaceId: "workspace-test",
      title: "Recovered",
      committedEvents: [{ seq: 0 }],
      adapterMetadata: { inheritedEventCount: 0 },
    });
  });

  it("preserves seeded RC1 fork lineage as Adapter-owned recovery metadata", () => {
    const recovered = recoverRc1ProjectionSession({
      schemaVersion: 1,
      runId: "run-seeded",
      nativeSessionId: "native-seeded",
      logicalSessionId: "logical-seeded",
      baseVersionId: "version-parent",
      mode: "maintenance-write",
      nativeRevision: 2,
      lastCommittedOperationId: null,
      derivedChildSessionId: null,
    } as never, {
      schemaVersion: 1,
      logicalSessionId: "logical-seeded",
      projectId: "project-test",
      workspaceId: null,
      title: "Seeded fork",
      tags: [],
      inheritedEventCount: 2,
      header: {
        version: 0,
        id: "native-seeded",
        createdAt: 2,
        cwd: "D:/Project",
        parentSession: "native-parent",
        isSeeded: true,
      },
      events: [{ seq: 0 }, { seq: 1 }],
    });

    expect(recovered).toMatchObject({
      header: { isSeeded: true, parentSession: "native-parent" },
      adapterMetadata: { inheritedEventCount: 2 },
      committedEvents: [{ seq: 0 }, { seq: 1 }],
    });
  });
});
