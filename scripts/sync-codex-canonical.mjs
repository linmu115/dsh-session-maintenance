import { resolve } from "node:path";

import { CanonicalSessionEngine } from "../packages/canonical-session-engine/dist/index.js";
import {
  openMaintenanceDatabase,
  SqliteCanonicalRepository,
  SqliteCanonicalSessionEngineStore,
  ZstdContentObjectStore,
} from "../packages/session-store/dist/index.js";
import { CodexCanonicalImportService } from "../apps/engine/dist/codex-canonical-import.js";
import { SqliteCodexProjectPort } from "../apps/engine/dist/sqlite-codex-project-port.js";

const [stateRootValue, databaseValue, codexHomeValue, instanceId = "codex-main"] = process.argv.slice(2);
if (!stateRootValue || !databaseValue || !codexHomeValue) {
  throw new TypeError(
    "usage: sync-codex-canonical.mjs <state-root> <metadata.sqlite> <codex-home> [instance-id]",
  );
}

const stateRoot = resolve(stateRootValue);
const database = openMaintenanceDatabase(resolve(databaseValue));
const repository = new SqliteCanonicalRepository(database);
const canonicalEngine = new CanonicalSessionEngine(
  new SqliteCanonicalSessionEngineStore(database, new ZstdContentObjectStore(stateRoot)),
);
let completed = 0;
try {
  const result = await new CodexCanonicalImportService({
    canonicalEngine,
    projectPort: new SqliteCodexProjectPort(repository),
  }).sync({
    instance: {
      id: instanceId,
      platform: "codex",
      displayName: "Codex Desktop",
      root: resolve(codexHomeValue),
      platformVersion: "0.146.0",
    },
    onStatus: (status) => {
      if (status.stage !== "canonical.import" || status.state !== "succeeded") return;
      completed += 1;
      if (completed % 25 === 0) {
        process.stderr.write(`sync-codex-canonical: ${completed} visible sessions committed\n`);
      }
    },
  });
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  console.log(JSON.stringify({ ok: true, result }, null, 2));
  if (result.retried !== 0) process.exitCode = 1;
} finally {
  database.close();
}
