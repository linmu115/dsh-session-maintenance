import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const requiredPackageManager = "pnpm@11.19.0";
const minimumNode = [22, 19, 0];

function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (!match) {
    throw new Error(`Unable to parse Node version: ${version}`);
  }

  return match.slice(1).map(Number);
}

function isAtLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    const actualPart = actual[index] ?? 0;
    const minimumPart = minimum[index] ?? 0;
    if (actualPart !== minimumPart) {
      return actualPart > minimumPart;
    }
  }

  return true;
}

if (manifest.packageManager !== requiredPackageManager) {
  throw new Error(
    `packageManager must be ${requiredPackageManager}; received ${String(manifest.packageManager)}`,
  );
}

if (!isAtLeast(parseVersion(process.version), minimumNode)) {
  throw new Error(`Node >=${minimumNode.join(".")} is required; received ${process.version}`);
}

const userAgent = process.env.npm_config_user_agent ?? "";
if (!userAgent.startsWith("pnpm/11.19.0 ")) {
  throw new Error(
    `Run bootstrap through ${requiredPackageManager}; received ${userAgent || "no package-manager identity"}`,
  );
}

const pnpmEntrypoint = process.env.npm_execpath;
if (!pnpmEntrypoint || !/pnpm(?:\.c?js|\.mjs)$/iu.test(pnpmEntrypoint)) {
  throw new Error("pnpm did not expose a trusted npm_execpath entrypoint");
}

const result = spawnSync(
  process.execPath,
  [pnpmEntrypoint, "install", "--frozen-lockfile"],
  {
    cwd: root,
    env: process.env,
    shell: false,
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
