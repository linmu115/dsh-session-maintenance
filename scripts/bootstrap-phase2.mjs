import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lock = resolve(root, "pnpm-lock.yaml");
const hash = async () => createHash("sha256").update(await readFile(lock)).digest("hex");
const before = await hash();
const entry = process.env.npm_execpath;
if (entry === undefined) throw new Error("Run bootstrap:phase2 through pnpm 11.19.0");
const result = spawnSync(process.execPath, [entry, "bootstrap"], { cwd: root, env: process.env, stdio: "inherit", shell: false });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const after = await hash();
if (before !== after) throw new Error("Pinned bootstrap changed pnpm-lock.yaml");
process.stdout.write(`phase2 bootstrap stable: ${after}\n`);
