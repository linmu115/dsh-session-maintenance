import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { AdapterId } from "@linmu/dsh-session-contracts";

import {
  MAINTENANCE_SCHEMA_VERSION,
  SqliteAdapterEvidenceStore,
  SqliteSessionRepository,
  ZstdContentObjectStore,
  openMaintenanceDatabase,
} from "../src/index.js";

const roots: string[] = [];
const at = "2026-09-03T01:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Adapter evidence store", () => {
  it("keeps native payloads content-addressed, Adapter-scoped and GC-reachable", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-sm-evidence-"));
    roots.push(root);
    const objectStore = new ZstdContentObjectStore(root);
    const database = openMaintenanceDatabase(join(root, "metadata.sqlite"));
    const evidence = new SqliteAdapterEvidenceStore(database, objectStore, { clock: () => at });
    const adapterId = "dsh-alpha2" as AdapterId;
    try {
      const input = {
        schemaVersion: 1 as const,
        adapterId,
        nativeFormatId: "dsh/0.1.2-alpha.2/session-event-v1",
        sourceKind: "dsh-alpha2/future/private",
        payload: { type: "future/private", secret: "adapter-only" },
        observedAt: at,
      };
      const first = await evidence.putEvidence(input);
      const second = await evidence.putEvidence(input);

      expect(first).toEqual(second);
      expect(first.ref).toMatch(/^evidence:sha256:[0-9a-f]{64}$/u);
      expect(JSON.stringify(first)).not.toContain("adapter-only");
      expect(await evidence.readEvidence(first.ref, adapterId)).toEqual(input);
      expect(await evidence.readEvidence(first.ref, "another-adapter" as AdapterId)).toBeUndefined();
      expect(database.prepare("PRAGMA table_info(adapter_evidence)").all())
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "payload" })]));
      expect(await new SqliteSessionRepository(database, objectStore).listReachableObjectIds())
        .toContain(first.objectId);
      expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
        .toEqual({ version: MAINTENANCE_SCHEMA_VERSION });
    } finally {
      database.close();
    }
  });
});
