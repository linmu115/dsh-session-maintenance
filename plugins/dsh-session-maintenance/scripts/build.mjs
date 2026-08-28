import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(pluginRoot, "..", "..");
const lib = join(pluginRoot, "lib");

await rm(lib, { recursive: true, force: true });
await mkdir(join(lib, "client"), { recursive: true });

await build({
  absWorkingDir: workspaceRoot,
  entryPoints: ["plugins/dsh-session-maintenance/src/index.ts"],
  outfile: join(lib, "index.js"),
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
});

await build({
  absWorkingDir: workspaceRoot,
  entryPoints: ["plugins/dsh-session-maintenance/src/client/index.tsx"],
  outfile: join(lib, "client", "index.js"),
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
});

await copyFile(join(workspaceRoot, "packages", "dsh-core-extension", "dist", "rc2-host.js"), join(lib, "rc2-host.js"));
await writeFile(join(lib, "index.d.ts"), "export declare const name = \"dsh-session-maintenance\";\nexport declare function apply(ctx: unknown, config: unknown): void;\n");
await writeFile(join(lib, "client", "index.d.ts"), "export declare function apply(ctx: unknown): void;\n");
