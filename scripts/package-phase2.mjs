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
const sourcePluginManifest = JSON.parse(await readFile(join(root, "plugins", "dsh-session-maintenance", "package.json"), "utf8"));
const sourceEngineManifest = JSON.parse(await readFile(join(root, "apps", "engine", "package.json"), "utf8"));
const version = sourcePluginManifest.version;
const engineVersion = sourceEngineManifest.version;

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
await mkdir(join(engine, "engine", "adapters"), { recursive: true });

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
  external: ["react", "react/jsx-runtime"],
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
await copyFile(join(root, "plugins", "dsh-session-maintenance", "CHANGELOG.md"), join(plugin, "CHANGELOG.md"));
await copyFile(join(root, "plugins", "dsh-session-maintenance", "LICENSE"), join(plugin, "LICENSE"));
await cp(join(root, "plugins", "dsh-session-maintenance", "dsh-management"), join(plugin, "dsh-management"), { recursive: true });
await writeFile(join(plugin, "lib", "index.d.ts"), "export declare const name = \"dsh-session-maintenance\";\nexport declare function apply(ctx: unknown, config: unknown): void;\n");
await writeFile(join(plugin, "lib", "client", "index.d.ts"), "export declare function apply(ctx: unknown): void;\n");
const packagedPluginManifest = {
  ...sourcePluginManifest,
  files: ["lib", "dsh-management", "cordis.patch.yml", "CHANGELOG.md", "README.md", "LICENSE"],
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
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  metafile: true,
});
const alpha2WorkerBundle = await build({
  absWorkingDir: root,
  entryPoints: ["packages/adapter-dsh-alpha2/src/rpc-worker.ts"],
  outfile: join(engine, "engine", "adapters", "dsh-alpha2-rpc-worker.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  conditions: ["development"],
  legalComments: "none",
  metafile: true,
});
const rc1WorkerBundle = await build({
  absWorkingDir: root,
  entryPoints: ["packages/adapter-dsh-rc1/src/rpc-worker.ts"],
  outfile: join(engine, "engine", "adapters", "dsh-rc1-rpc-worker.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  conditions: ["development"],
  legalComments: "none",
  metafile: true,
});
const rc2WorkerBundle = await build({
  absWorkingDir: root,
  entryPoints: ["packages/adapter-dsh-rc2/src/rpc-worker.ts"],
  outfile: join(engine, "engine", "adapters", "dsh-rc2-rpc-worker.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  conditions: ["development"],
  legalComments: "none",
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

const sourceCommit = await git("rev-parse", "HEAD");
const sourceDirty = (await git("status", "--porcelain")) !== "";
const componentPaths = [
  "apps/engine", "apps/dashboard", "plugins/dsh-session-maintenance", "packages/contracts",
  "packages/adapter-dsh-alpha2", "packages/adapter-dsh-rc1", "packages/adapter-dsh-rc2",
];
const components = await Promise.all(componentPaths.map(async (path) => {
  const value = JSON.parse(await readFile(join(root, path, "package.json"), "utf8"));
  return { name: value.name, version: value.version, sourcePath: path };
}));
const schemaSource = await readFile(join(root, "packages/session-store/src/schema.ts"), "utf8");
const schemaMatch = /export const MAINTENANCE_SCHEMA_VERSION = (\d+) as const;/u.exec(schemaSource);
if (schemaMatch === null) throw new Error("Cannot identify the packaged metadata schema version");
const lockfileSha256 = sha256(await readFile(join(root, "pnpm-lock.yaml")));
const buildInfo = {
  schemaVersion: 1,
  version,
  engineVersion,
  sourceCommit,
  sourceDirty,
  metadataSchemaVersion: Number(schemaMatch[1]),
  protocolVersions: { adapterApi: 1, projection: 1, externalLifecycle: 1 },
  components,
  lockfile: { name: "pnpm-lock.yaml", sha256: lockfileSha256 },
};
await writeFile(join(engine, "BUILD-INFO.json"), `${stableJson(buildInfo)}\n`);
const pluginBytes = await deterministicTarGz(plugin, "package");
await writeFile(join(engine, "engine", "dsh-session-maintenance.tgz"), pluginBytes);
await writeFile(join(engine, "engine", "integration-package.json"), `${stableJson({
  schemaVersion: 1,
  file: "dsh-session-maintenance.tgz",
  sha256: sha256(pluginBytes).slice("sha256:".length),
})}\n`);
const engineBytes = await deterministicTarGz(engine, "dsh-session-maintenance");
const pluginName = `dsh-session-maintenance-${version}.tgz`;
const engineName = `dsh-session-maintenance-engine-${engineVersion}.tgz`;
await writeFile(join(out, pluginName), pluginBytes);
await writeFile(join(out, engineName), engineBytes);
const manifest = {
  ...buildInfo,
  supportedContracts: { dsh: "0.1.1-rc.2", dshRc1: "0.1.2-rc.1", cordis: "4.0.2", codexRead: "0.146.0" },
  artifacts: [
    { name: engineName, sha256: sha256(engineBytes), bytes: engineBytes.byteLength, kind: "engine-dashboard" },
    { name: pluginName, sha256: sha256(pluginBytes), bytes: pluginBytes.byteLength, kind: "dsh-plugin" },
  ],
  dependencyInputs: {
    engine: portableInputs(engineBundle.metafile),
    adapterWorkers: {
      alpha2: portableInputs(alpha2WorkerBundle.metafile),
      rc1: portableInputs(rc1WorkerBundle.metafile),
      rc2: portableInputs(rc2WorkerBundle.metafile),
    },
    pluginHost: portableInputs(pluginHost.metafile),
    pluginClient: portableInputs(pluginClient.metafile),
  },
};
await writeFile(join(out, "phase2-manifest.json"), `${stableJson(manifest)}\n`);
await rm(staging, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ output: out, artifacts: manifest.artifacts })}\n`);
