import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const ignored = new Set([".git", "node_modules", "dist", "coverage"]);
const textExtensions = new Set([".ts", ".mts", ".js", ".mjs", ".json", ".yaml", ".yml", ".md"]);
const files = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (entry.isFile() && textExtensions.has(extname(entry.name))) files.push(path);
  }
}

await visit(root);
const failures = [];
const runtime = (path) => {
  const name = relative(root, path).replaceAll("\\", "/");
  return (
    /^apps\/[^/]+\/src\//u.test(name) ||
    (/^packages\/[^/]+\/src\//u.test(name) && !name.startsWith("packages/test-support/"))
  );
};

for (const path of files) {
  const name = relative(root, path).replaceAll("\\", "/");
  const content = await readFile(path, "utf8");
  if (runtime(path)) {
    if (/(?:^|["'`(\s])[A-Za-z]:[\\/]/mu.test(content) || /\/(?:Users|home)\//u.test(content)) {
      failures.push(`${name}: runtime absolute path`);
    }
    if (/\bEAC\b|web-desktop/iu.test(content)) failures.push(`${name}: retired shell coupling`);
    if (/from\s+["'][^"']+\/src\//u.test(content)) failures.push(`${name}: compiled source-path import`);
  }
  const secretPrefix = ["s", "k", "-"].join("");
  if (new RegExp(`${secretPrefix}[A-Za-z0-9_-]{20,}`, "u").test(content)) failures.push(`${name}: credential canary`);
  const privateKey = ["BEGIN", " (?:RSA|OPENSSH|EC) ", "PRIVATE KEY"].join("");
  if (new RegExp(privateKey, "u").test(content)) failures.push(`${name}: private-key canary`);
}

const packageFiles = files.filter((path) => path.endsWith("package.json"));
const workspaceNames = new Set();
for (const path of packageFiles) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (typeof value.name === "string") workspaceNames.add(value.name);
}
for (const path of packageFiles) {
  const name = relative(root, path).replaceAll("\\", "/");
  const value = JSON.parse(await readFile(path, "utf8"));
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [dependency, version] of Object.entries(value[section] ?? {})) {
      if (typeof version !== "string") continue;
      if (version.startsWith("file:") || version.startsWith("link:")) failures.push(`${name}: forbidden ${dependency}=${version}`);
      if (version.startsWith("workspace:") && !workspaceNames.has(dependency)) failures.push(`${name}: unknown workspace dependency ${dependency}`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`portable: ${files.length} text files checked\n`);
}
