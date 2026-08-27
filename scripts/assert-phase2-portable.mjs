import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { RC2_CORE_HOST_MATERIALIZATION } from "../packages/dsh-core-extension/dist/materialization.js";
import { readTarGz, sha256 } from "./phase2-pack-lib.mjs";

const outFlag = process.argv.indexOf("--out");
const out = resolve(outFlag >= 0 ? process.argv[outFlag + 1] : ".artifacts/phase2");
const manifest = JSON.parse(await readFile(join(out, "phase2-manifest.json"), "utf8"));
const failures = [];
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
  const index = engine.get("dsh-session-maintenance/dashboard/index.html")?.toString("utf8") ?? "";
  if (!index.includes("/dashboard/assets/")) failures.push("Dashboard asset base is not /dashboard/");
  if (!engine.has("dsh-session-maintenance/engine/dsh-session-maint.mjs")) failures.push("Engine bundle is missing");
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
