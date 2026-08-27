import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { deterministicTarGz, sha256, stableJson } from "./phase2-pack-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const out = resolve(outFlag >= 0 ? args[outFlag + 1] : join(root, ".artifacts", "phase2"));
const skipBuild = args.includes("--skip-build");
const version = "0.1.0";

function runPnpm(...argv) {
  const entry = process.env.npm_execpath;
  if (entry === undefined) throw new Error("Run package:phase2 through pinned pnpm");
  const result = spawnSync(process.execPath, [entry, ...argv], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function git(...argv) {
  const result = spawnSync("git", argv, { cwd: root, encoding: "utf8", shell: false, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${argv.join(" ")} failed`);
  return result.stdout.trim();
}

function portableInputs(metafile) {
  return Object.keys(metafile.inputs)
    .map((path) => relative(root, resolve(root, path)).replaceAll("\\", "/"))
    .filter((path) => !path.startsWith("../") && !path.includes("node_modules/.pnpm/"))
    .sort();
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
if (!skipBuild) runPnpm("build");

const staging = join(out, ".staging");
const plugin = join(staging, "plugin");
const engine = join(staging, "engine", "dsh-session-maintenance");
await mkdir(join(plugin, "lib", "client"), { recursive: true });
await mkdir(join(engine, "engine"), { recursive: true });

const pluginHost = await build({
  absWorkingDir: root,
  entryPoints: ["plugins/dsh-session-maintenance/src/index.ts"],
  outfile: join(plugin, "lib", "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  conditions: ["development"],
  external: [
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-session",
    "@deepseek-ai/dsh-session-persistence",
    "@deepseek-ai/dsh-session-projection-cache",
    "@deepseek-ai/dsh-session-query",
    "@deepseek-ai/dsh-workspace",
  ],
  legalComments: "none",
  metafile: true,
});
const pluginClient = await build({
  absWorkingDir: root,
  entryPoints: ["plugins/dsh-session-maintenance/src/client/index.tsx"],
  outfile: join(plugin, "lib", "client", "index.js"),
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2023",
  conditions: ["development"],
  legalComments: "none",
  banner: {
    js: 'window.__ModuleLoader__.load({ id: "dsh-session-maintenance", factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: "return module.exports;\n}});" },
  metafile: true,
});
await copyFile(join(root, "packages", "dsh-core-extension", "dist", "rc2-host.js"), join(plugin, "lib", "rc2-host.js"));
await copyFile(join(root, "plugins", "dsh-session-maintenance", "cordis.patch.yml"), join(plugin, "cordis.patch.yml"));
await copyFile(join(root, "plugins", "dsh-session-maintenance", "README.md"), join(plugin, "README.md"));
await copyFile(join(root, "plugins", "dsh-session-maintenance", "LICENSE"), join(plugin, "LICENSE"));
await writeFile(join(plugin, "lib", "index.d.ts"), "export declare const name = \"dsh-session-maintenance\";\nexport declare function apply(ctx: unknown, config: unknown): void;\n");
await writeFile(join(plugin, "lib", "client", "index.d.ts"), "export declare function apply(ctx: unknown): void;\n");
const sourcePluginManifest = JSON.parse(await readFile(join(root, "plugins", "dsh-session-maintenance", "package.json"), "utf8"));
const packagedPluginManifest = {
  ...sourcePluginManifest,
  files: ["lib", "cordis.patch.yml", "README.md", "LICENSE"],
  dependencies: {},
};
delete packagedPluginManifest.devDependencies;
delete packagedPluginManifest.scripts;
await writeFile(join(plugin, "package.json"), `${stableJson(packagedPluginManifest)}\n`);

const engineBundle = await build({
  absWorkingDir: root,
  entryPoints: ["apps/engine/src/main.ts"],
  outfile: join(engine, "engine", "dsh-session-maint.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  conditions: ["development"],
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node" },
  metafile: true,
});
await cp(join(root, "apps", "dashboard", "dist"), join(engine, "dashboard"), { recursive: true });
await writeFile(join(engine, "Start-Session-Maintenance.cmd"), [
  "@echo off",
  "setlocal",
  "set \"DSM_ROOT=%~dp0\"",
  "if not defined DSM_STATE_ROOT set \"DSM_STATE_ROOT=%LOCALAPPDATA%\\DSH-Session-Maintenance\"",
  "node \"%DSM_ROOT%engine\\dsh-session-maint.mjs\" --state-root \"%DSM_STATE_ROOT%\" serve --dashboard-root \"%DSM_ROOT%dashboard\" %*",
  "endlocal",
  "",
].join("\r\n"));
await writeFile(join(engine, "INSTALL-INPUTS.json"), `${stableJson({
  schemaVersion: 1,
  profile: "caller-selected-official-profile",
  stateRoot: "caller-selected",
  dshInstanceId: "caller-selected",
  dshOrigin: "http://127.0.0.1:caller-selected-port",
  connectionEnvironmentId: "primary",
})}\n`);

const pluginBytes = await deterministicTarGz(plugin, "package");
const engineBytes = await deterministicTarGz(engine, "dsh-session-maintenance");
const pluginName = `dsh-session-maintenance-${version}.tgz`;
const engineName = `dsh-session-maintenance-engine-${version}.tgz`;
await writeFile(join(out, pluginName), pluginBytes);
await writeFile(join(out, engineName), engineBytes);
const sourceCommit = await git("rev-parse", "HEAD");
const sourceDirty = (await git("status", "--porcelain")) !== "";
const manifest = {
  schemaVersion: 1,
  version,
  sourceCommit,
  sourceDirty,
  supportedContracts: { dsh: "0.1.1-rc.2", cordis: "4.0.1", codexRead: "0.146.0" },
  artifacts: [
    { name: engineName, sha256: sha256(engineBytes), bytes: engineBytes.byteLength, kind: "engine-dashboard" },
    { name: pluginName, sha256: sha256(pluginBytes), bytes: pluginBytes.byteLength, kind: "dsh-plugin" },
  ],
  dependencyInputs: {
    engine: portableInputs(engineBundle.metafile),
    pluginHost: portableInputs(pluginHost.metafile),
    pluginClient: portableInputs(pluginClient.metafile),
  },
};
await writeFile(join(out, "phase2-manifest.json"), `${stableJson(manifest)}\n`);
await rm(staging, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ output: out, artifacts: manifest.artifacts })}\n`);
