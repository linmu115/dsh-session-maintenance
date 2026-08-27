import { spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { sha256 } from "./phase2-pack-lib.mjs";

const first = resolve(".artifacts/phase2-repro-a");
const second = resolve(".artifacts/phase2-repro-b");
const entry = process.env.npm_execpath;
if (entry === undefined) throw new Error("Run verify:phase2-package through pnpm");
const run = (out, skipBuild) => {
  const result = spawnSync(process.execPath, ["scripts/package-phase2.mjs", "--out", out, ...(skipBuild ? ["--skip-build"] : [])], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
await rm(first, { recursive: true, force: true });
await rm(second, { recursive: true, force: true });
run(first, false);
run(second, true);
for (const name of ["dsh-session-maintenance-0.1.0.tgz", "dsh-session-maintenance-engine-0.1.0.tgz", "phase2-manifest.json"]) {
  const left = await readFile(join(first, name));
  const right = await readFile(join(second, name));
  if (sha256(left) !== sha256(right)) throw new Error(`Phase 2 package is not reproducible: ${name}`);
}
await rm(resolve(".artifacts/phase2"), { recursive: true, force: true });
await import("./package-phase2.mjs");
await rm(first, { recursive: true, force: true });
await rm(second, { recursive: true, force: true });
process.stdout.write("phase2 package reproducible: 3/3 outputs\n");
