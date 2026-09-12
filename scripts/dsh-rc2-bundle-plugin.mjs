import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The released LLM module computes its version through createRequire, which esbuild cannot relocate. */
export function dshRc2PackageMetadata() {
  return {
    name: "fixed-rc2-package-metadata",
    setup(build) {
      build.onLoad({ filter: /[\\/]@deepseek-ai[\\/]dsh-llm[\\/]lib[\\/]index\.js$/ }, async ({ path }) => {
        const manifestPath = join(dirname(path), "..", "package.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        if (manifest.name !== "@deepseek-ai/dsh-llm" || manifest.version !== "0.1.5-rc.2") {
          throw new Error("Engine bundle resolved an unsupported DSH LLM package");
        }
        const source = await readFile(path, "utf8");
        const pattern = /createRequire\(import\.meta\.url\)\(["']\.\.\/package\.json["']\)/gu;
        if ([...source.matchAll(pattern)].length !== 1) throw new Error("Pinned RC2 package metadata seam drifted");
        return { contents: source.replace(pattern, JSON.stringify({ version: manifest.version })), loader: "js", resolveDir: dirname(path), watchFiles: [path, manifestPath] };
      });
    },
  };
}
