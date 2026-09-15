import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

export const PACKAGED_SOURCE_DOCUMENTS = [
  "docs/superpowers/specs/2026-09-15-extension-ownership-and-session-reader.md",
  "docs/deployment/UPGRADE.md",
  "docs/deployment/RECOVERY.md",
];
const sourceReadme = "plugins/dsh-session-maintenance/README.md";
const targets = new Map([[sourceReadme, "README.md"], ...PACKAGED_SOURCE_DOCUMENTS.map(path => [path, path])]);
const links = /(?<!!)\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/gu;
const external = target => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(target);

export function rewritePackagedReadmeLinks(text, sourcePath, sourceCommit) {
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("Package documentation requires an exact source commit");
  const destination = targets.get(sourcePath);
  if (destination === undefined) throw new Error("Unknown packaged documentation source");
  return text.replace(links, (original, label, angle, plain) => {
    const target = angle ?? plain;
    if (external(target)) return original;
    const [location, fragment] = target.split("#");
    const resolved = posix.normalize(posix.join(posix.dirname(sourcePath), decodeURIComponent(location)));
    if (resolved.startsWith("../") || posix.isAbsolute(resolved)) throw new Error("Documentation target escapes source repository");
    const packaged = targets.get(resolved);
    const path = packaged === undefined
      ? `https://github.com/linmu115/dsh-session-maintenance/blob/${sourceCommit}/${resolved}`
      : posix.relative(posix.dirname(destination), packaged);
    return `[${label}](${path}${fragment === undefined ? "" : `#${fragment}`})`;
  });
}
export async function packagePluginDocumentation(root, pluginRoot, sourceCommit) {
  for (const [sourcePath, destination] of targets) {
    const contents = rewritePackagedReadmeLinks(await readFile(join(root, sourcePath), "utf8"), sourcePath, sourceCommit);
    await mkdir(dirname(join(pluginRoot, destination)), { recursive: true });
    await writeFile(join(pluginRoot, destination), contents);
  }
  return [...targets.values()];
}
export function missingPackagedDocumentLinks(entries) {
  const failures = [];
  for (const [name, bytes] of entries) {
    if (name !== "package/README.md" && !/^package\/docs\/.*\.md$/u.test(name)) continue;
    for (const match of bytes.toString("utf8").matchAll(links)) {
      const target = match[2] ?? match[3];
      if (external(target)) continue;
      const path = posix.normalize(posix.join(posix.dirname(name), decodeURIComponent(target.split("#")[0])));
      if (!path.startsWith("package/") || !entries.has(path)) failures.push(`${name}: missing local documentation target ${target}`);
    }
  }
  return failures;
}
