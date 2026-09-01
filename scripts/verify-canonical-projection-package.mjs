import { spawnSync } from "node:child_process";
import { readFile, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { readTarGz, sha256 } from "./phase2-pack-lib.mjs";

const root = process.cwd();
const first = resolve(".artifacts/canonical-repro-a");
const second = resolve(".artifacts/canonical-repro-b");
const published = resolve(".artifacts/canonical-projection");

function run(out) {
  const result = spawnSync(process.execPath, ["scripts/package-canonical-projection.mjs", "--out", out], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function filesUnder(directory) {
  const files = [];
  const visit = async (current) => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(relative(directory, path).replaceAll("\\", "/"));
    }
  };
  await visit(directory);
  return files;
}

await rm(first, { recursive: true, force: true });
await rm(second, { recursive: true, force: true });
run(first);
run(second);
const leftFiles = await filesUnder(first);
const rightFiles = await filesUnder(second);
if (JSON.stringify(leftFiles) !== JSON.stringify(rightFiles)) throw new Error("Canonical package file lists differ");
for (const name of leftFiles) {
  const left = await readFile(join(first, name));
  const right = await readFile(join(second, name));
  if (sha256(left) !== sha256(right)) throw new Error(`Canonical package is not reproducible: ${name}`);
  if (name.endsWith(".tgz")) {
    for (const entry of readTarGz(left).keys()) {
      if (/(?:^|\/)(?:sessions?|objects?|projection-homes?)(?:\/|$)|\.sqlite(?:-|$)|session\.jsonl/iu.test(entry)) {
        throw new Error(`User session or state content leaked into ${name}: ${entry}`);
      }
    }
  }
}
const manifest = JSON.parse(await readFile(join(first, "canonical-projection-generation.json"), "utf8"));
if (manifest.dataPolicy?.includesUserSessions !== false || manifest.dataPolicy?.includesMaintenanceDatabase !== false) {
  throw new Error("Canonical Generation data policy is missing");
}
await rm(published, { recursive: true, force: true });
run(published);
await rm(first, { recursive: true, force: true });
await rm(second, { recursive: true, force: true });
process.stdout.write(`canonical package reproducible: ${leftFiles.length}/${leftFiles.length} outputs (${manifest.generationId})\n`);
