import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deterministicTarGz, sha256, stableJson } from "./phase2-pack-lib.mjs";
import { externalizeDshHostPackages } from "./canonical-plugin-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(process.env.DSH_PLUGIN_REPOSITORIES_ROOT ?? dirname(root));
const aiRoot = dirname(repositoryRoot);
const stateRoot = resolve(process.env.DSH_MAINTENANCE_STATE_ROOT ?? join(aiRoot, "DSH-Maintenance-State"));
const baselineGenerationId = process.env.DSH_CANONICAL_BASE_GENERATION ?? "gen-4a88122cf2a71716";
const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const outputRoot = resolve(outFlag >= 0 ? args[outFlag + 1] : join(root, ".artifacts", "canonical-projection"));
const staging = join(outputRoot, ".staging");

const replacements = new Map([
  ["dsh-annotation-core", {
    repo: join(repositoryRoot, "dsh-annotation-core"),
    paths: ["lib", "cordis.patch.yml", "docs/changes", "docs/release/verification.md", "CHANGELOG.md", "README.md", "README_EN.md", "LICENSE"],
  }],
  ["dsh-session-sticker-board", {
    repo: join(repositoryRoot, "dsh-session-sticker-board"),
    paths: ["lib", "src", "cordis.patch.yml", "CHANGELOG.md", "README.md", "LICENSE"],
  }],
  ["obsidian-deepharness-bridge", {
    repo: join(repositoryRoot, "obsidian-deepharness-bridge"),
    paths: ["main.js", "styles.css", "manifest.json", "versions.json", "scripts", "CHANGELOG.md", "README.md", "LICENSE"],
  }],
]);

const workspacePackages = [
  { path: "packages/contracts", kind: "adapter-contracts", docs: [] },
  { path: "packages/session-adapter-sdk", kind: "adapter-sdk", docs: [] },
  { path: "packages/adapter-dsh-alpha2", kind: "dsh-adapter", docs: ["CHANGELOG.md", "BREAKING-CHANGES.md", "COMPATIBILITY.md"] },
  { path: "packages/adapter-dsh-rc2", kind: "dsh-adapter", docs: ["CHANGELOG.md", "BREAKING-CHANGES.md", "COMPATIBILITY.md"] },
];

function runNode(script, argv = []) {
  const result = spawnSync(process.execPath, [script, ...argv], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${script} failed`);
}

function git(cwd, ...argv) {
  const result = spawnSync("git", argv, { cwd, encoding: "utf8", shell: false, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${argv.join(" ")} failed`);
  return result.stdout.trim();
}

async function mustExist(path) {
  try {
    await access(path);
  } catch {
    throw new Error(`Required Generation input is missing: ${path}`);
  }
}

async function copyPaths(sourceRoot, targetRoot, paths) {
  for (const relativePath of paths) {
    const source = join(sourceRoot, relativePath);
    await mustExist(source);
    const target = join(targetRoot, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true });
  }
}

function portableManifest(source, versionByName) {
  const rewrite = (dependencies = {}) => Object.fromEntries(Object.entries(dependencies).map(([name, spec]) => [
    name,
    typeof spec === "string" && spec.startsWith("workspace:") ? versionByName.get(name) ?? "*" : spec,
  ]));
  const manifest = {
    ...source,
    private: false,
    dependencies: rewrite(source.dependencies),
    peerDependencies: rewrite(source.peerDependencies),
    optionalDependencies: rewrite(source.optionalDependencies),
  };
  delete manifest.devDependencies;
  delete manifest.scripts;
  return manifest;
}

async function packRepositoryPackage(input, versionByName) {
  const sourceManifest = JSON.parse(await readFile(join(input.repo, "package.json"), "utf8"));
  const packageRoot = join(staging, "external", sourceManifest.name.replaceAll("/", "__"));
  await mkdir(packageRoot, { recursive: true });
  await copyPaths(input.repo, packageRoot, input.paths);
  const manifest = externalizeDshHostPackages(portableManifest(sourceManifest, versionByName));
  await writeFile(join(packageRoot, "package.json"), `${stableJson(manifest)}\n`);
  const bytes = await deterministicTarGz(packageRoot, "package");
  return {
    bytes,
    name: sourceManifest.name,
    version: sourceManifest.version,
    repository: input.repo,
    branch: git(input.repo, "branch", "--show-current"),
    commit: git(input.repo, "rev-parse", "HEAD"),
    dirty: git(input.repo, "status", "--porcelain") !== "",
  };
}

async function packWorkspacePackage(input, versionByName) {
  const sourceRoot = join(root, input.path);
  const sourceManifest = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  const packageRoot = join(staging, "workspace", sourceManifest.name.replaceAll("/", "__"));
  await mkdir(packageRoot, { recursive: true });
  await copyPaths(sourceRoot, packageRoot, ["dist", ...input.docs]);
  const manifest = portableManifest(sourceManifest, versionByName);
  manifest.files = ["dist", ...input.docs];
  await writeFile(join(packageRoot, "package.json"), `${stableJson(manifest)}\n`);
  return {
    bytes: await deterministicTarGz(packageRoot, "package"),
    name: sourceManifest.name,
    version: sourceManifest.version,
    kind: input.kind,
  };
}

function artifactFilename(name, version) {
  return `${name.replace(/^@/u, "").replaceAll("/", "-")}-${version}.tgz`;
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
const baselineRoot = join(stateRoot, "generations", baselineGenerationId);
const baseline = JSON.parse(await readFile(join(baselineRoot, "generation.lock.json"), "utf8"));
if (baseline.generationId !== baselineGenerationId) throw new Error("Baseline Generation identity mismatch");
if (baseline.runtime?.version !== "0.1.2-alpha.2") throw new Error("Canonical package baseline must be the verified Alpha2 Generation");

const versionByName = new Map();
for (const input of workspacePackages) {
  const manifest = JSON.parse(await readFile(join(root, input.path, "package.json"), "utf8"));
  versionByName.set(manifest.name, manifest.version);
}
for (const input of replacements.values()) {
  const manifest = JSON.parse(await readFile(join(input.repo, "package.json"), "utf8"));
  versionByName.set(manifest.name, manifest.version);
}

const coreRoot = join(staging, "core");
runNode("scripts/package-phase2.mjs", ["--out", coreRoot, "--skip-build"]);
const coreManifest = JSON.parse(await readFile(join(coreRoot, "phase2-manifest.json"), "utf8"));
const artifactRecords = [];
const artifactsRoot = join(outputRoot, "artifacts");
await mkdir(artifactsRoot, { recursive: true });

for (const artifact of coreManifest.artifacts) {
  const source = join(coreRoot, artifact.name);
  const bytes = await readFile(source);
  await copyFile(source, join(artifactsRoot, artifact.name));
  artifactRecords.push({ ...artifact, sha256: sha256(bytes), role: artifact.kind });
}

for (const input of workspacePackages) {
  const packed = await packWorkspacePackage(input, versionByName);
  const filename = artifactFilename(packed.name, packed.version);
  await writeFile(join(artifactsRoot, filename), packed.bytes);
  artifactRecords.push({ name: filename, sha256: sha256(packed.bytes), bytes: packed.bytes.byteLength, role: packed.kind, packageName: packed.name, version: packed.version });
}

const packagedReplacements = new Map();
for (const [name, input] of replacements) {
  const packed = await packRepositoryPackage(input, versionByName);
  if (packed.dirty) throw new Error(`Generation input repository is dirty: ${packed.repository}`);
  const filename = artifactFilename(packed.name, packed.version);
  await writeFile(join(artifactsRoot, filename), packed.bytes);
  const record = {
    name: filename,
    sha256: sha256(packed.bytes),
    bytes: packed.bytes.byteLength,
    role: name === "obsidian-deepharness-bridge" ? "obsidian-companion" : "dsh-plugin",
    packageName: packed.name,
    version: packed.version,
    repository: { branch: packed.branch, commit: packed.commit },
  };
  artifactRecords.push(record);
  packagedReplacements.set(name, record);
}

const pluginRecords = [];
for (const plugin of baseline.plugins) {
  if (plugin.name === "dsh-session-maintenance") {
    const corePlugin = artifactRecords.find((item) => item.role === "dsh-plugin" && item.name.startsWith("dsh-session-maintenance-"));
    const manifest = JSON.parse(await readFile(join(root, "plugins", "dsh-session-maintenance", "package.json"), "utf8"));
    pluginRecords.push({ ...plugin, version: manifest.version, repository: { path: root, branch: git(root, "branch", "--show-current"), commit: git(root, "rev-parse", "HEAD") }, artifact: corePlugin });
    continue;
  }
  const replacement = packagedReplacements.get(plugin.name);
  if (replacement !== undefined) {
    pluginRecords.push({ ...plugin, version: replacement.version, repository: { ...plugin.repository, branch: replacement.repository.branch, commit: replacement.repository.commit }, artifact: replacement });
    continue;
  }
  const source = join(stateRoot, plugin.artifact.relativePath);
  await mustExist(source);
  const bytes = await readFile(source);
  if (sha256(bytes).slice("sha256:".length) !== plugin.artifact.sha256) throw new Error(`Baseline artifact digest mismatch: ${plugin.name}`);
  const filename = artifactFilename(plugin.name, plugin.version);
  await writeFile(join(artifactsRoot, filename), bytes);
  const record = { name: filename, sha256: sha256(bytes), bytes: bytes.byteLength, role: plugin.enabled ? "dsh-plugin" : "companion-snapshot", packageName: plugin.name, version: plugin.version };
  artifactRecords.push(record);
  pluginRecords.push({ ...plugin, artifact: record });
}

const profiles = {
  schemaVersion: 1,
  generation: "canonical-projection",
  profiles: {
    alpha2: { sessionSource: "maintenance", maintenanceEndpoint: "auto", adapterSelection: "pinned", pinnedAdapterId: "dsh-alpha2", branchId: null },
    rc2: { sessionSource: "maintenance", maintenanceEndpoint: "auto", adapterSelection: "pinned", pinnedAdapterId: "dsh-rc2", branchId: null },
  },
};
await writeFile(join(outputRoot, "launcher-profiles.json"), `${stableJson(profiles)}\n`);

const documentationRoot = join(outputRoot, "documentation");
await mkdir(documentationRoot, { recursive: true });
await cp(join(root, "docs", "adapters"), join(documentationRoot, "adapters"), { recursive: true });
for (const relativePath of [
  "docs/superpowers/specs/2026-08-31-session-maintenance-canonical-projection-design.md",
  "docs/validation/canonical-migration-preview.md",
  "docs/deployment/canonical-projection-generation.md",
  "docs/validation/canonical-projection-final.md",
]) {
  const source = join(root, relativePath);
  await mustExist(source);
  await copyFile(source, join(documentationRoot, basename(source)));
}

const sourceCommit = git(root, "rev-parse", "HEAD");
const sourceDiff = git(root, "diff", "--binary", "HEAD");
const sourceTreeDigest = `sha256:${createHash("sha256").update(sourceCommit).update("\0").update(sourceDiff).digest("hex")}`;
const manifestBase = {
  schemaVersion: 1,
  title: "Session Maintenance Canonical Projection",
  baselineGenerationId,
  runtimeMatrix: ["0.1.2-alpha.2", "0.1.1-rc.2"],
  source: { commit: sourceCommit, dirty: git(root, "status", "--porcelain") !== "", treeDigest: sourceTreeDigest },
  adapters: ["dsh-alpha2", "dsh-rc2"],
  artifacts: artifactRecords.sort((left, right) => left.name.localeCompare(right.name)),
  plugins: pluginRecords,
  excluded: ["dsh-codex-session-sync"],
  dataPolicy: { includesUserSessions: false, includesMaintenanceDatabase: false, projectionHomesAreTemporary: true },
  rollback: { databaseFile: "metadata.sqlite", generationId: baselineGenerationId },
};
const contentHash = createHash("sha256").update(stableJson(manifestBase)).digest("hex");
const manifest = { ...manifestBase, generationId: `canonical-${contentHash.slice(0, 16)}`, contentHash };
await writeFile(join(outputRoot, "canonical-projection-generation.json"), `${stableJson(manifest)}\n`);
await rm(staging, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ output: outputRoot, generationId: manifest.generationId, artifacts: manifest.artifacts.length })}\n`);
