import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { registerFlatRetentionCandidate } from "../src/index.js";
import { NOW, retentionFixture } from "./retention-fixture.js";

async function manifest(path: string) {
  const bytes = await readFile(path);
  await writeFile(`${path}.manifest.json`, JSON.stringify({ schemaVersion: 1, candidatePath: path,
    candidateDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, createdAt: NOW }));
  return bytes;
}

describe("retention schema 21 compatibility boundary", () => {
  it("reads schema 21 body references and verifies a static recovery point without changing it", async () => {
    const f = await retentionFixture();
    try {
      const body = await f.addVersion("head", "retained schema 21 body");
      expect(f.database.prepare("SELECT MAX(version) version FROM schema_migrations").get()?.version).toBe(21);
      const path = await f.external("schema21"), before = await manifest(path);
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

  it.each([15, 18, 22, 999])("continues to reject unsupported schema %s for references and static candidates", async (schema) => {
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
