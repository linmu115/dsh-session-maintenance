import { resolve } from "node:path";
import { runCli } from "../apps/engine/dist/cli.js";
import { activeDatabasePath, loadConfig, registeredInstances } from "../apps/engine/dist/config.js";

const [stateRootValue, databaseValue, codexHomeValue, instanceId = "codex-main", ...options] = process.argv.slice(2);
if (!stateRootValue || !databaseValue || !codexHomeValue || options.some((option) => option !== "--offline")) {
  throw new TypeError("usage: sync-codex-canonical.mjs <state-root> <metadata.sqlite> <codex-home> [instance-id] [--offline]");
}
const stateRoot = resolve(stateRootValue);
const config = await loadConfig(stateRoot); // read only; no database open or migration
const instance = registeredInstances(config).find((item) => item.id === instanceId && item.platform === "codex");
if (resolve(activeDatabasePath(stateRoot, config)) !== resolve(databaseValue) || instance === undefined || resolve(instance.root) !== resolve(codexHomeValue)) {
  throw new Error("Import paths must match the Engine's registered instance and active database");
}
// Online is the default. Failure never silently opens the database offline.
process.exitCode = await runCli(["--state-root", stateRoot, "canonical", "import", "--instance", instanceId, ...options]);
