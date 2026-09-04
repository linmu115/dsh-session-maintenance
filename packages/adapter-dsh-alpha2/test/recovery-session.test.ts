import { describe, expect, it } from "vitest";

import { recoverAlpha2ProjectionSession } from "../src/recovery-session.js";

describe("recoverAlpha2ProjectionSession", () => {
  it("uses the committed projection watermark and preserves project/workspace separation", () => {
    const recovered = recoverAlpha2ProjectionSession({
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
      tags: ["alpha2"],
      header: { version: 0, id: "native-test", cwd: "D:/Project" },
      events: [{ seq: 0 }, { seq: 1 }],
    });

    expect(recovered).toMatchObject({
      projectId: "project-test",
      workspaceId: "workspace-test",
      title: "Recovered",
      committedEvents: [{ seq: 0 }],
    });
  });
});
