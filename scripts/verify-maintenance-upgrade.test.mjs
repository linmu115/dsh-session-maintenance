import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { CanonicalSessionEngine } from "../packages/canonical-session-engine/dist/index.js";
import { openMaintenanceDatabase, SqliteCanonicalSessionEngineStore, ZstdContentObjectStore } from "../packages/session-store/dist/index.js";
import { assertFixtureSandbox, createFixtureSandbox } from "../packages/test-support/dist/index.js";
import { deterministicTarGz } from "./phase2-pack-lib.mjs";
import { verifyMaintenanceUpgrade } from "./verify-maintenance-upgrade.mjs";

const enginePackage = process.env.DSH_UPGRADE_TEST_ENGINE_PACKAGE;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("a packaged candidate migrates only the copied database and preserves stable content", { skip: !enginePackage }, async () => {
  const fixture = await createFixtureSandbox("upgrade-verifier-source");
  const path = join(fixture.root, "source.sqlite");
  const database = openMaintenanceDatabase(path);
  let closed = false;
  try {
    const engine = new CanonicalSessionEngine(new SqliteCanonicalSessionEngineStore(database, new ZstdContentObjectStore(fixture.root)));
    const logicalSessionId = "synthetic-upgrade-session";
    await engine.observeCodex({
      logicalSessionId, title: "Synthetic original", tags: ["fixture"], archivedAt: null,
      workspaceId: null, sourceCursor: "first", observedAt: "2001-01-01T00:00:00.000Z",
      events: [{
        schemaVersion: 1, id: "synthetic-upgrade-event", logicalSessionId, sequence: 0,
        kind: "user-message", role: "user", content: { text: "Synthetic content must survive" },
        source: { platform: "codex", instanceId: "fixture", sessionId: "source", eventId: "event", cursor: "first" },
        contentDigest: "sha256:" + hash("Synthetic content must survive"), rawPayload: null, extensions: {},
      }],
    });
    await engine.retitleCodexMirror({ logicalSessionId, title: "Synthetic current", appliedAt: "2001-01-02T00:00:00.000Z" });
    database.exec("DROP TRIGGER session_version_metadata_created; DROP TRIGGER version_metadata_immutable; DROP TABLE version_metadata_snapshots; DELETE FROM schema_migrations WHERE version=17");
    database.close(); closed = true;
    const sourceHash = hash(await readFile(path));
    const result = await verifyMaintenanceUpgrade({ sourceDatabase: path, enginePackage });
    assert.equal(hash(await readFile(path)), sourceHash);
    assert.equal(result.sourceSchema, 16);
    assert.equal(result.candidateSchema, 17);
    assert.equal(result.invariants.session_versions.rows, 2);
    assert.equal(result.invariants.version_parents.rows, 1);
    assert.equal(result.invariants.canonical_events.rows, 1);
    assert.equal(result.metadata.unknownPersistenceTimes, 2);
    assert.equal(result.repeatedOpenStable, true);
    assert.equal(JSON.stringify(result).includes("Synthetic content must survive"), false);
    assert.equal(JSON.stringify(result).includes("Synthetic current"), false);
  } finally {
    if (!closed) database.close();
    assertFixtureSandbox(fixture.root);
    await fixture.cleanup();
  }
});

test("invalid candidate schema is rejected before opening the source", async () => {
  const fixture = await createFixtureSandbox("upgrade-invalid-schema");
  try {
    const contents = join(fixture.root, "contents");
    await mkdir(contents);
    await writeFile(join(contents, "BUILD-INFO.json"), JSON.stringify({ metadataSchemaVersion: -1 }));
    const archive = join(fixture.root, "invalid.tgz");
    await writeFile(archive, await deterministicTarGz(contents, "dsh-session-maintenance"));
    await assert.rejects(verifyMaintenanceUpgrade({ sourceDatabase: join(fixture.root, "not-created.sqlite"), enginePackage: archive }), /Candidate schema is invalid/);
  } finally { assertFixtureSandbox(fixture.root); await fixture.cleanup(); }
});

test("a candidate without build identity is rejected before opening the source", async () => {
  const fixture = await createFixtureSandbox("upgrade-missing-identity");
  try {
    const contents = join(fixture.root, "contents");
    await mkdir(contents);
    await writeFile(join(contents, "unrelated.txt"), "synthetic");
    const archive = join(fixture.root, "invalid.tgz");
    await writeFile(archive, await deterministicTarGz(contents, "outside"));
    await assert.rejects(verifyMaintenanceUpgrade({ sourceDatabase: join(fixture.root, "not-created.sqlite"), enginePackage: archive }), /no BUILD-INFO/);
  } finally { assertFixtureSandbox(fixture.root); await fixture.cleanup(); }
});
