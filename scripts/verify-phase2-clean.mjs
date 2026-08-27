import { spawnSync } from "node:child_process";

const entry = process.env.npm_execpath;
if (entry === undefined) throw new Error("Run verify:phase2-clean through pnpm");
for (const argv of [
  ["bootstrap:phase2"],
  ["typecheck"],
  ["build"],
  ["verify:phase2-package"],
  ["test:phase1", "--", "--maxWorkers=1", "--testTimeout=15000"],
  ["test:phase2"],
  ["assert:phase2-portable"],
  ["accept:phase2-isolated"],
]) {
  const result = spawnSync(process.execPath, [entry, ...argv], { cwd: process.cwd(), env: process.env, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
