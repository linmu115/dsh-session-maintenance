import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "./phase2-pack-lib.mjs";

export const PHASE2_COMPONENT_PATHS = [
  "apps/engine", "apps/dashboard", "plugins/dsh-session-maintenance", "packages/contracts",
  "packages/adapter-dsh-0-1-5", "packages/adapter-dsh-gpt-compat", "packages/adapter-dsh-alpha2", "packages/adapter-dsh-rc1", "packages/adapter-dsh-rc2",
];
export function completeComponentInventory(components) {
  return Array.isArray(components) && components.length === PHASE2_COMPONENT_PATHS.length
    && PHASE2_COMPONENT_PATHS.every(path => components.filter(component => component.sourcePath === path).length === 1);
}
export function normalizedTextHash(bytes) {
  return sha256(Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n")));
}
export async function readDsh015HostProvenance(root) {
  const sourcePath = "packages/dsh-core-extension/src/dsh-015-host.ts";
  const buildPath = "packages/dsh-core-extension/dist/dsh-015-host.js";
  return { adapterId: "dsh-0.1.5", sourcePath, buildPath, artifactPath: "lib/dsh-015-host.js",
    sourceHash: normalizedTextHash(await readFile(join(root, sourcePath))),
    artifactHash: normalizedTextHash(await readFile(join(root, buildPath))) };
}
export function validDsh015HostProvenance(actual, expected, entries) {
  return actual !== null && typeof actual === "object"
    && Object.keys(expected).every(key => actual[key] === expected[key])
    && entries.has(`package/${expected.artifactPath}`)
    && normalizedTextHash(entries.get(`package/${expected.artifactPath}`)) === expected.artifactHash;
}
