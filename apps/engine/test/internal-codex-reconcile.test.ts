import { describe, expect, it } from "vitest";

import { logicalSessionIdFor } from "@linmu/dsh-session-domain";

import { CodexCanonicalImportService } from "../src/codex-canonical-import.js";
import { reconcileInternalCodexSessions } from "../src/internal-codex-reconcile.js";
import { SqliteCodexProjectPort } from "../src/sqlite-codex-project-port.js";
import { SqliteCanonicalRepository } from "@linmu/dsh-session-store";
import { createEngineFixture } from "./helpers.js";

describe("internal Codex session reconciliation", () => {
  it("creates one checkpoint and recoverably hides matched canonical mirrors", async () => {
    const fixture = await createEngineFixture("internal-codex-reconcile");
    try {
      const repository = new SqliteCanonicalRepository(fixture.engine.repository.database);
      const importer = new CodexCanonicalImportService({
        canonicalEngine: fixture.engine.canonicalEngine,
        projectPort: new SqliteCodexProjectPort(repository),
        fixtureGuard: fixture.fixturePolicy,
      });
      const instance = fixture.engine.instances.find((item) => item.platform === "codex")!;
      await importer.sync({ instance });
      const at = "2026-09-01T00:00:00.000Z";
      const retentionUntil = "2027-09-01T00:00:00.000Z";
      const preview = reconcileInternalCodexSessions(
        fixture.engine.repository.database,
        ["thread-fixture", "missing-thread"],
        { apply: false, at, retentionUntil },
      );
      expect(preview).toMatchObject({ requested: 2, matched: 1, tombstoned: 0, checkpointId: null });

      const applied = reconcileInternalCodexSessions(
        fixture.engine.repository.database,
        ["thread-fixture", "missing-thread"],
        { apply: true, at, retentionUntil },
      );
      expect(applied).toMatchObject({ requested: 2, matched: 1, tombstoned: 1 });
      expect(applied.checkpointId).toMatch(/^checkpoint-codex-internal-/u);
      const logicalSessionId = logicalSessionIdFor({
        platform: "codex",
        instanceId: instance.id,
        sessionId: "thread-fixture",
      });
      expect(await fixture.engine.canonicalEngine.store.getSession(logicalSessionId as never)).toMatchObject({
        session: { tombstonedAt: at },
        workspaceId: null,
        tombstone: { checkpointId: applied.checkpointId, retentionUntil },
      });
      expect(fixture.engine.repository.database.prepare(
        "SELECT COUNT(*) AS count FROM checkpoints WHERE id = ?",
      ).get(applied.checkpointId)).toEqual({ count: 1 });
    } finally {
      await fixture.cleanupAll();
    }
  });
});
