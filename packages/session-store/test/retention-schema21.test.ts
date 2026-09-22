import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { registerFlatRetentionCandidate, MAINTENANCE_SCHEMA_VERSION } from "../src/index.js";
import { NOW, retentionFixture } from "./retention-fixture.js";

async function manifest(path: string) {
  const bytes = await readFile(path);
  await writeFile(`${path}.manifest.json`, JSON.stringify({ schemaVersion: 1, candidatePath: path,
    candidateDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, createdAt: NOW }));
  return bytes;
}

describe("retention schema 21 compatibility boundary", () => {
  it.each([21,22,23,24,25,26,27,28])("reads schema %s body references and verifies a static recovery point without changing it", async (schema) => {
    const f = await retentionFixture();
    try {
      const body = await f.addVersion("head", "retained schema 21 body");
      expect(f.database.prepare("SELECT MAX(version) version FROM schema_migrations").get()?.version).toBe(MAINTENANCE_SCHEMA_VERSION);
      const path = await f.external("schema21");
      if (schema < 28) {
        const db = new DatabaseSync(path);
        try {
          db.exec("DROP TABLE runtime_workspace_registrations; DROP TABLE runtime_workspace_bindings; ALTER TABLE projection_run_workspace_scopes DROP COLUMN cache_revision; DELETE FROM schema_migrations WHERE version=28");
          if (schema < 27) db.exec("DROP TABLE projection_run_workspace_scopes; DELETE FROM schema_migrations WHERE version=27");
          if (schema < 26) db.exec("DROP TABLE instance_workspace_policies; DELETE FROM schema_migrations WHERE version=26");
          if (schema < 25) db.exec("DROP TRIGGER learning_body_revision; DROP TABLE learning_handoffs; DROP TABLE learning_bindings; DELETE FROM schema_migrations WHERE version=25");
          if (schema < 24) db.exec("DROP TABLE extension_object_owners; DELETE FROM schema_migrations WHERE version=24");
          if (schema < 23) db.exec("DROP TABLE context_read_executions; DELETE FROM schema_migrations WHERE version=23");
          if (schema === 21) db.exec("DROP TABLE extension_conflicts; DROP TABLE extension_objects; DROP TABLE extension_connections; DELETE FROM schema_migrations WHERE version=22");
        } finally { db.close(); }
      }
      const before = await manifest(path);
      const inventory = await f.repository.capture(NOW);
      expect(inventory.blockers).toEqual([]);
      expect(inventory.references).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "active", targetId: body, reason: "retained-version-body" }),
        expect.objectContaining({ source: "schema21", targetId: body, reason: "retained-external-database-body" }),
      ]));
      const resource = await registerFlatRetentionCandidate(f.repository, "schema21", NOW);
      expect(resource.verifiedAt).toBe(NOW);
      expect(resource.sqliteBundle).toEqual(["schema21.sqlite", "schema21.sqlite.manifest.json"]);
      expect(await readFile(path)).toEqual(before);
    } finally { await f.close(); }
  });

  it.each([15, 18, 30, 999])("continues to reject unsupported schema %s for references and static candidates", async (schema) => {
    const f = await retentionFixture();
    try {
      await f.addVersion("head");
      const path = await f.external(`unsupported-${schema}`);
      const database = new DatabaseSync(path);
      try {
        database.prepare("DELETE FROM schema_migrations WHERE version > ?").run(schema);
        database.prepare("INSERT OR REPLACE INTO schema_migrations (version,applied_at) VALUES (?,?)").run(schema, NOW);
      } finally { database.close(); }
      const before = await manifest(path);
      expect((await f.repository.capture(NOW)).blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: `unsupported-${schema}`, code: "unknown-format", detail: `Unsupported reference schema ${schema}` }),
      ]));
      await expect(registerFlatRetentionCandidate(f.repository, `unsupported-${schema}`, NOW)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED", cause: { message: "Unsupported or invalid candidate database" } });
      expect(await readFile(path)).toEqual(before);
    } finally { await f.close(); }
  });

  it("still rejects foreign-key corruption in an otherwise supported schema 21 candidate", async () => {
    const f = await retentionFixture();
    try {
      await f.addVersion("head");
      const path = await f.external("corrupt21"), database = new DatabaseSync(path);
      try {
        database.exec("PRAGMA foreign_keys=OFF");
        database.prepare("INSERT INTO codex_project_mapping_removals (logical_session_id,operation_id,policy_revision,workspace_json) VALUES ('missing-session','synthetic',1,NULL)").run();
      } finally { database.close(); }
      const before = await manifest(path);
      expect((await f.repository.capture(NOW)).blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "corrupt21", code: "unreadable" }),
      ]));
      await expect(registerFlatRetentionCandidate(f.repository, "corrupt21", NOW)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED", cause: { message: "Unsupported or invalid candidate database" } });
      expect(await readFile(path)).toEqual(before);
    } finally { await f.close(); }
  });
});
