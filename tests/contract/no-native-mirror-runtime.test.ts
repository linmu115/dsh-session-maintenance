import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

async function sourceFiles(path: string): Promise<readonly string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = resolve(path, entry.name);
    if (entry.isDirectory() && ["dist", "node_modules"].includes(entry.name)) return [];
    if (entry.isDirectory()) return sourceFiles(absolute);
    return /\.(?:ts|tsx|json)$/u.test(entry.name) ? [absolute] : [];
  }));
  return nested.flat();
}

describe("native mirror runtime removal", () => {
  it("has no production package, import or HTTP operation path", async () => {
    await expect(access(resolve(root, "packages/native-mirror-engine/package.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const files = (await Promise.all([
      sourceFiles(resolve(root, "apps")),
      sourceFiles(resolve(root, "packages")),
      sourceFiles(resolve(root, "plugins")),
    ])).flat();
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (
        source.includes("@linmu/dsh-session-native-mirror-engine") ||
        source.includes("/v1/mirrors") ||
        source.includes("NativeMirrorService")
      ) violations.push(file.slice(root.length + 1));
    }
    expect(violations).toEqual([]);
  });
});
