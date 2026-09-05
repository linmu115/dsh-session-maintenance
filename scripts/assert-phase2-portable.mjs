import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { RC2_CORE_HOST_MATERIALIZATION } from "../packages/dsh-core-extension/dist/materialization.js";
import { readTarGz, sha256 } from "./phase2-pack-lib.mjs";

const outFlag = process.argv.indexOf("--out");
const out = resolve(outFlag >= 0 ? process.argv[outFlag + 1] : ".artifacts/phase2");
const manifest = JSON.parse(await readFile(join(out, "phase2-manifest.json"), "utf8"));
const failures = [];
const expectedEngine = JSON.parse(await readFile(resolve("apps/engine/package.json"), "utf8"));
const expectedPlugin = JSON.parse(await readFile(resolve("plugins/dsh-session-maintenance/package.json"), "utf8"));
const expectedSchema = /MAINTENANCE_SCHEMA_VERSION = (\d+) as const;/u.exec(
  await readFile(resolve("packages/session-store/src/schema.ts"), "utf8"),
);
if (manifest.engineVersion !== expectedEngine.version || manifest.version !== expectedPlugin.version) {
  failures.push("release component versions do not match the source");
}
if (expectedSchema === null || manifest.metadataSchemaVersion !== Number(expectedSchema[1])) {
  failures.push("release metadata schema does not match the source");
}
if (manifest.lockfile?.name !== "pnpm-lock.yaml" ||
    manifest.lockfile.sha256 !== sha256(await readFile(resolve("pnpm-lock.yaml")))) {
  failures.push("release lockfile digest does not match the source");
}
for (const component of manifest.components ?? []) {
  const componentPath = resolve(component.sourcePath);
  if (!componentPath.startsWith(resolve(".") + "/") && !componentPath.startsWith(resolve(".") + "\\")) {
    failures.push("release component source path is outside the workspace");
    continue;
  }
  const expected = JSON.parse(await readFile(join(componentPath, "package.json"), "utf8"));
  if (component.name !== expected.name || component.version !== expected.version) {
    failures.push("release component identity does not match its source: " + component.sourcePath);
  }
}
if (manifest.components?.length !== 7) failures.push("release component inventory is incomplete");
if (manifest.protocolVersions?.adapterApi !== 1 || manifest.protocolVersions?.projection !== 1 ||
    manifest.protocolVersions?.externalLifecycle !== 1) failures.push("release protocol versions are incompatible");
const archives = new Map();
for (const artifact of manifest.artifacts ?? []) {
  const bytes = await readFile(join(out, artifact.name));
  if (sha256(bytes) !== artifact.sha256 || bytes.byteLength !== artifact.bytes) failures.push(`${artifact.name}: manifest hash/size mismatch`);
  archives.set(artifact.kind, readTarGz(bytes));
}
const plugin = archives.get("dsh-plugin");
const engine = archives.get("engine-dashboard");
if (plugin === undefined || engine === undefined) failures.push("required artifacts are missing");
if (plugin !== undefined) {
  const packageJson = JSON.parse(plugin.get("package/package.json")?.toString("utf8") ?? "null");
  for (const [name, version] of Object.entries(packageJson?.dependencies ?? {})) {
    if (name.startsWith("@linmu/") || String(version).startsWith("workspace:") || String(version).startsWith("file:")) {
      failures.push(`plugin dependency is not self-contained: ${name}=${version}`);
    }
  }
  const rc2Host = plugin.get("package/lib/rc2-host.js");
  if (rc2Host === undefined || sha256(Buffer.from(rc2Host.toString("utf8").replaceAll("\r\n", "\n"))) !== RC2_CORE_HOST_MATERIALIZATION.artifactHash) {
    failures.push("plugin rc.2 Core host materialization hash drifted");
  }
}
if (engine !== undefined) {
  const buildInfo = JSON.parse(engine.get("dsh-session-maintenance/BUILD-INFO.json")?.toString("utf8") ?? "null");
  for (const key of ["schemaVersion", "version", "engineVersion", "sourceCommit", "sourceDirty", "metadataSchemaVersion", "protocolVersions", "components", "lockfile"]) {
    if (JSON.stringify(buildInfo?.[key]) !== JSON.stringify(manifest[key])) failures.push("packaged build identity does not match manifest: " + key);
  }
  const index = engine.get("dsh-session-maintenance/dashboard/index.html")?.toString("utf8") ?? "";
  if (!index.includes("/dashboard/assets/")) failures.push("Dashboard asset base is not /dashboard/");
  const engineBundle = engine.get("dsh-session-maintenance/engine/dsh-session-maint.mjs")?.toString("utf8");
  if (engineBundle === undefined) failures.push("Engine bundle is missing");
  else {
    const workerEntries = [
      "dsh-session-maintenance/engine/adapters/dsh-alpha2-rpc-worker.mjs",
      "dsh-session-maintenance/engine/adapters/dsh-rc1-rpc-worker.mjs",
      "dsh-session-maintenance/engine/adapters/dsh-rc2-rpc-worker.mjs",
    ];
    for (const entry of workerEntries) {
      if (engine.get(entry) === undefined) failures.push(`Packaged Adapter worker is missing: ${entry}`);
    }
    const hashbang = "#!/usr/bin/env node\n";
    if (!engineBundle.startsWith(hashbang) || engineBundle.slice(hashbang.length).startsWith("#!")) {
      failures.push("Engine bundle must contain exactly one leading Node hashbang");
    } else {
      const smokeRoot = await mkdtemp(join(tmpdir(), "dsh-session-maintenance-engine-smoke-"));
      const smokeEntry = join(smokeRoot, "dsh-session-maint.mjs");
      try {
        await writeFile(smokeEntry, engineBundle);
        await mkdir(join(smokeRoot, "adapters"), { recursive: true });
        for (const entry of workerEntries) {
          const bytes = engine.get(entry);
          if (bytes === undefined) continue;
          const workerPath = join(smokeRoot, "adapters", entry.split("/").at(-1));
          await writeFile(workerPath, bytes);
          const worker = spawnSync(process.execPath, [workerPath], {
            input: `${JSON.stringify({ id: 1, method: "probe", payload: {} })}\n`,
            encoding: "utf8",
            shell: false,
            windowsHide: true,
            timeout: 15_000,
          });
          if (worker.error !== undefined || worker.status !== 0 || !worker.stdout.includes('"id":1')) {
            failures.push(`Packaged Adapter worker is not executable: ${entry}`);
          }
        }
        const result = spawnSync(process.execPath, [smokeEntry, "--help"], {
          encoding: "utf8",
          shell: false,
          windowsHide: true,
          timeout: 15_000,
        });
        if (result.error !== undefined || result.status !== 0) {
          failures.push(`Packaged Engine is not executable: ${result.error?.message ?? result.stderr.trim().split(/\r?\n/u)[0] ?? `exit ${String(result.status)}`}`);
        }
      } finally {
        await rm(smokeRoot, { recursive: true, force: true });
      }
    }
  }
}
const forbidden = [
  /dsh-codex-session-sync/iu,
  /\/codex-sync/iu,
  /\bEAC\b/iu,
  /web-desktop/iu,
  /(?:^|["'`\s])(?:[A-Za-z]:[\\/]|\/(?:Users|home)\/)/mu,
  /(?:file|link):[A-Za-z]:/iu,
  /workspace:\*/u,
  /Bearer\s+[A-Za-z0-9_-]{20,}/u,
];
for (const [kind, entries] of archives) {
  for (const [name, bytes] of entries) {
    if (!/\.(?:js|mjs|json|md|yml|yaml|cmd|html|css)$/iu.test(name)) continue;
    const text = bytes.toString("utf8");
    for (const pattern of forbidden) if (pattern.test(text)) failures.push(`${kind}:${name}: forbidden ${pattern.source}`);
  }
}
if (failures.length > 0) {
  failures.forEach((failure) => process.stderr.write(`${failure}\n`));
  process.exitCode = 1;
} else {
  process.stdout.write(`phase2 portable: ${[...archives.values()].reduce((sum, entries) => sum + entries.size, 0)} artifact files checked\n`);
}
