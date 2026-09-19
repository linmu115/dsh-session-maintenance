// Derive a lifecycle-only build from the user's installed release. Never rebuild
// or replace its dashboard, plugin packages, adapters, or UI assets.
import { build } from "esbuild";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dshRc2PackageMetadata } from "./dsh-rc2-bundle-plugin.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
function option(name) { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`); return resolve(args[index + 1]); }
const base = option("--base"), out = option("--out");
if (out === base || out.startsWith(base + "/") || out.startsWith(base + "\\")) throw new Error("Output must be separate from the installed release");
const original = JSON.parse(await readFile(join(base, "BUILD-INFO.json"), "utf8"));
const hashes = async (directory, prefix = "") => {
  const result = {};
  for (const item of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isSymbolicLink()) throw new Error("Release contains an unexpected link");
    if (item.isDirectory()) Object.assign(result, await hashes(directory, path));
    else result[path] = createHash("sha256").update(await readFile(join(directory, path))).digest("hex");
  }
  return result;
};
const before = await hashes(base);
await mkdir(out); // Refuse to overwrite any existing candidate or installed path.
await cp(base, out, { recursive: true, force: false, errorOnExist: true });
await build({ plugins: [dshRc2PackageMetadata()], absWorkingDir: root,
  entryPoints: ["apps/engine/src/main.ts"], outfile: join(out, "engine/dsh-session-maint.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node24", conditions: ["development"], legalComments: "none",
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
const sourceDirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8", windowsHide: true }).trim().length > 0;
await writeFile(join(out, "BUILD-INFO.json"), JSON.stringify({ ...original,
  sourceCommit, sourceDirty, localPatch: "startup-recovery-20260919", baseSourceCommit: original.sourceCommit,
}, null, 2) + "\n");
const after = await hashes(out);
const changed = Object.keys(before).filter(path => before[path] !== after[path]);
if (changed.some(path => !["engine/dsh-session-maint.mjs", "BUILD-INFO.json"].includes(path))) throw new Error("Unrelated release files changed");
await writeFile(join(out, "STARTUP-RECOVERY-INFO.json"), JSON.stringify({ schemaVersion: 1, sourceCommit, sourceDirty,
  baseRelease: base, changed, unchangedFiles: Object.keys(before).length - changed.length,
  engineSha256: after["engine/dsh-session-maint.mjs"], newProviderPhases: ["recoverBeforeStart", "started"],
  uiAcceptance: "not-performed", deployment: "not-installed",
}, null, 2) + "\n");
console.log(JSON.stringify({ out, changed, unchangedFiles: Object.keys(before).length - changed.length }));
