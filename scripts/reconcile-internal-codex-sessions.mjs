import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { listInternalCodexThreadIds } from "../packages/adapter-codex-read/dist/index.js";
import { reconcileInternalCodexSessions } from "../apps/engine/dist/internal-codex-reconcile.js";
import { MaintenanceWriteCoordinator, openMaintenanceDatabase } from "../packages/session-store/dist/index.js";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (key === "--apply" || key === "--offline") args.set(key, true);
  else args.set(key, process.argv[++index]);
}
const codexHome = resolve(String(args.get("--codex-home") ?? ""));
const databasePath = resolve(String(args.get("--database") ?? ""));
const expected = args.has("--expected-count") ? Number.parseInt(String(args.get("--expected-count")), 10) : undefined;
if (!existsSync(resolve(codexHome, "state_5.sqlite"))) throw new TypeError("--codex-home must contain state_5.sqlite");
if (!existsSync(databasePath)) throw new TypeError("--database must name an existing Maintenance database");
const instance = {
  id: "codex-main",
  platform: "codex",
  displayName: "Codex Desktop",
  root: codexHome,
  platformVersion: "0.146.0",
};
const internalIds = listInternalCodexThreadIds(instance);
if (expected !== undefined && internalIds.length !== expected) {
  throw new Error(`Internal Codex thread count changed: expected ${expected}, got ${internalIds.length}`);
}
const at = new Date().toISOString();
const retentionUntil = new Date(Date.parse(at) + 365 * 24 * 60 * 60 * 1000).toISOString();
const apply = args.get("--apply") === true;
if (apply && args.get("--offline") !== true) throw new Error("Reconciliation writes require --offline and verified exclusive ownership");
const writes = apply ? MaintenanceWriteCoordinator.acquire(dirname(databasePath), "offline") : undefined;
const execute = () => {
  // Preview never invokes the migrating opener, including while an Engine owns the database.
  const database = apply ? openMaintenanceDatabase(databasePath) : new DatabaseSync(databasePath, { readOnly: true });
  try {
  const result = reconcileInternalCodexSessions(database, internalIds, {
    apply,
    at,
    retentionUntil,
  });
  console.log(JSON.stringify({ mode: args.get("--apply") === true ? "apply" : "preview", ...result }, null, 2));
  } finally { database.close(); }
};
try { if (writes) await writes.run("internal-reconciliation", execute); else execute(); }
finally { if (writes) { await writes.drain(); writes.close(); } }
