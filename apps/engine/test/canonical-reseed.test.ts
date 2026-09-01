import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openMaintenanceDatabase } from "@linmu/dsh-session-store";

import { reseedCanonicalCandidate, type CanonicalReseedStatus } from "../src/canonical-reseed.js";
import { createEngineFixture } from "./helpers.js";

describe("canonical Alpha2 reseed", () => {
  it("builds a separate verified candidate with native DSH and hot Codex sessions", async () => {
    const fixture = await createEngineFixture("canonical-reseed");
    const statuses: CanonicalReseedStatus[] = [];
    const candidateFile = "metadata.alpha2-reseed-test.sqlite";
    try {
      const manifest = await reseedCanonicalCandidate({
        stateRoot: fixture.root,
        candidateFile,
        dshHome: fixture.dshHome,
        dshInstanceId: "dsh-alpha2",
        retainedDshSessionIds: ["dsh-session-1"],
        maintenanceProjectName: "DeepSeek",
        maintenanceProjectRoot: "D:\\AI\\OCR\\DeepSeek",
        codexInstance: fixture.engine.instances.find((item) => item.platform === "codex")!,
        expectedCodexSessions: 1,
        fixtureGuard: fixture.fixturePolicy,
        now: () => "2026-09-01T00:00:00.000Z",
        onStatus: (status) => { statuses.push(status); },
      });

      expect(manifest).toMatchObject({
        dshImported: 1,
        codex: { scanned: 1, created: 1, retried: 0 },
        counts: {
          logicalSessions: 2,
          projectMemberships: 2,
          workspaceMemberships: 2,
          tombstones: 0,
        },
        integrityCheck: "ok",
        foreignKeyViolations: 0,
      });
      expect(statuses).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: "reseed.dsh.import", state: "succeeded" }),
        expect.objectContaining({ stage: "reseed.codex.import", state: "succeeded" }),
        expect.objectContaining({ stage: "reseed.verify", state: "succeeded" }),
      ]));

      const database = openMaintenanceDatabase(join(fixture.root, candidateFile));
      try {
        expect(database.prepare(
          `SELECT p.name, p.source_platform, r.root_path
           FROM logical_projects p JOIN project_roots r ON r.project_id = p.id
           WHERE p.name = 'DeepSeek'`,
        ).get()).toEqual({
          name: "DeepSeek",
          source_platform: "maintenance",
          root_path: "D:\\AI\\OCR\\DeepSeek",
        });
        const native = database.prepare(
          `SELECT authority_scope, origin_kind FROM logical_sessions
           WHERE origin_kind = 'maintenance-native'`,
        ).get();
        expect(native).toEqual({ authority_scope: "maintenance", origin_kind: "maintenance-native" });
        const nativeRaw = database.prepare(
          `SELECT event_json FROM canonical_events
           WHERE logical_session_id = (SELECT id FROM logical_sessions WHERE origin_kind = 'maintenance-native')
           ORDER BY sequence LIMIT 1`,
        ).get() as { readonly event_json: string };
        expect(JSON.parse(nativeRaw.event_json)).toMatchObject({
          rawPayload: { type: "user/message", seq: 0 },
        });
      } finally {
        database.close();
      }
      expect(JSON.parse(await readFile(`${manifest.candidatePath}.manifest.json`, "utf8"))).toMatchObject({
        candidateDigest: manifest.candidateDigest,
        counts: { logicalSessions: 2 },
      });
    } finally {
      await fixture.cleanupAll();
    }
  });
});
