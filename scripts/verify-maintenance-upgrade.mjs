import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertFixtureSandbox, createFixtureSandbox } from "../packages/test-support/dist/index.js";
import { readTarGz, sha256 } from "./phase2-pack-lib.mjs";

// These columns must survive additive schema migrations exactly. New retention
// columns and coordination journals have separate semantics and are not compared.
const INVARIANTS = [
  ["logical_sessions", "id", "id,display_title,canonical_version_id,sync_mode,archived,labels_json,authority_scope,origin_kind,head_version_id,archived_at,tombstoned_at,created_at,updated_at"],
  ["session_versions", "id", "id,logical_session_id,body_object,body_hash,metadata_hash,manifest_json,created_at"],
  ["version_parents", "version_id,ordinal", "version_id,ordinal,parent_id"],
  ["canonical_events", "logical_session_id,sequence", "id,logical_session_id,sequence,kind,content_digest,event_json"],
  ["session_derivations", "child_session_id", "child_session_id,parent_session_id,base_version_id,derivation_kind,trigger_run_id,trigger_operation_id,created_at"],
  ["checkpoints", "id", "id,name,description,refs_json,backup_transaction_ids_json,created_by,created_at"],
];

function digestRows(database, table, order, columns = "*") {
  const hash = createHash("sha256");
  let rows = 0;
  for (const row of database.prepare("SELECT " + columns + " FROM " + table + " ORDER BY " + order).iterate()) {
    hash.update(JSON.stringify(row));
    hash.update("\n");
    rows += 1;
  }
  return { rows, sha256: "sha256:" + hash.digest("hex") };
}

function inspect(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const quickCheck = database.prepare("PRAGMA quick_check").all();
    assert.ok(quickCheck.length === 1 && quickCheck[0].quick_check === "ok", "Copied database failed quick_check");
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0, "Copied database has foreign-key violations");
    const schema = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version;
    assert.ok(schema >= 16, "Upgrade verifier expects a schema 16 or newer baseline");
    const invariants = Object.fromEntries(INVARIANTS.map(([table, order, columns]) => [table, digestRows(database, table, order, columns)]));
    const hasMetadata = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='version_metadata_snapshots'").get() !== undefined;
    return {
      schema,
      invariants,
      metadata: hasMetadata ? {
        fingerprint: digestRows(database, "version_metadata_snapshots", "version_id"),
        availability: database.prepare("SELECT availability, COUNT(*) AS count FROM version_metadata_snapshots GROUP BY availability ORDER BY availability").all(),
        unknownPersistenceTimes: database.prepare("SELECT COUNT(*) AS count FROM version_metadata_snapshots WHERE first_persisted_at IS NULL").get().count,
      } : null,
    };
  } finally { database.close(); }
}

function execute(entry, stateRoot) {
  return new Promise((accept, reject) => {
    let diagnostic = "";
    const child = spawn(process.execPath, [entry, "--state-root", stateRoot, "status", "--json"], {
      cwd: stateRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    // The fixture has no home registrations. Keep process diagnostics bounded
    // and do not include status payloads, titles or database rows in the report.
    child.stdout.on("data", () => {});
    child.stderr.on("data", bytes => { diagnostic = (diagnostic + bytes).slice(-4096); });
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) accept();
      else reject(new Error("Candidate status failed (code=" + code + ", signal=" + signal + "): " + diagnostic));
    });
  });
}

export async function verifyMaintenanceUpgrade({ sourceDatabase, enginePackage }) {
  const archive = await readFile(resolve(enginePackage));
  const entries = readTarGz(archive);
  const buildBytes = entries.get("dsh-session-maintenance/BUILD-INFO.json");
  assert.ok(buildBytes, "Candidate archive has no BUILD-INFO.json");
  const build = JSON.parse(buildBytes.toString("utf8"));
  assert.ok(Number.isSafeInteger(build.metadataSchemaVersion) && build.metadataSchemaVersion >= 17, "Candidate schema is invalid");
  const fixture = await createFixtureSandbox("upgrade-copy-verification");
  const state = join(fixture.root, "state");
  const installation = join(fixture.root, "installation");
  const targetDatabase = join(state, "metadata.sqlite");
  const started = Date.now();
  try {
    assertFixtureSandbox(fixture.root);
    await mkdir(state);
    await mkdir(installation);
    for (const [name, bytes] of entries) {
      assert.ok(name.startsWith("dsh-session-maintenance/") && !name.includes("\\") && !name.split("/").includes(".."), "Invalid archive path");
      const target = resolve(installation, name);
      const suffix = relative(installation, target);
      assert.ok(suffix && !suffix.startsWith("..") && !isAbsolute(suffix), "Archive path escaped installation");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: "wx" });
    }
    // Only the input is opened here, and always read-only. The migration-capable
    // Engine sees only a SQLite online backup inside the marked temporary root.
    const source = new DatabaseSync(resolve(sourceDatabase), { readOnly: true });
    try { await backup(source, targetDatabase); } finally { source.close(); }
    const before = inspect(targetDatabase);
    assert.ok(before.schema <= build.metadataSchemaVersion, "Candidate would downgrade the copied database");
    const entry = join(installation, "dsh-session-maintenance/engine/dsh-session-maint.mjs");
    // With no config present the CLI creates its empty local configuration.
    // No original config, object directory, connection token or home is copied.
    await execute(entry, state);
    const after = inspect(targetDatabase);
    assert.equal(after.schema, build.metadataSchemaVersion, "Candidate migrated to an unexpected schema");
    assert.deepEqual(after.invariants, before.invariants, "Migration changed stable session/version content");
    if (before.metadata !== null) assert.deepEqual(after.metadata, before.metadata, "Migration changed existing immutable metadata");
    await execute(entry, state);
    const reopened = inspect(targetDatabase);
    assert.deepEqual(reopened, after, "Reopening the candidate changed preserved content or metadata");
    const config = await readFile(join(state, "config.yaml"), "utf8");
    assert.ok(!config.includes(resolve(sourceDatabase)), "Fixture config refers to the source database");
    return {
      verified: true,
      sourceDatabaseName: basename(sourceDatabase),
      sourceSchema: before.schema,
      candidateSchema: after.schema,
      candidateCommit: build.sourceCommit,
      candidatePackageSha256: sha256(archive),
      invariants: after.invariants,
      metadata: after.metadata,
      repeatedOpenStable: true,
      sourceOpenedReadOnly: true,
      originalConfigCopied: false,
      objectBodiesRead: false,
      elapsedMs: Date.now() - started,
    };
  } finally {
    assertFixtureSandbox(fixture.root);
    await fixture.cleanup();
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(resolve(process.argv[1])))) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--source-database" || args[2] !== "--engine-package") {
    throw new TypeError("Usage: node scripts/verify-maintenance-upgrade.mjs --source-database <SQLite> --engine-package <engine-dashboard.tgz>");
  }
  process.stdout.write(JSON.stringify(await verifyMaintenanceUpgrade({ sourceDatabase: args[1], enginePackage: args[3] })) + "\n");
}
