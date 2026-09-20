import { copyFile, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { writeBusinessPageDeclarations } from "./business-pages-declarations.mjs";
import { dshRc2PackageMetadata } from '../../../scripts/dsh-rc2-bundle-plugin.mjs';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(pluginRoot, "..", "..");
const lib = join(pluginRoot, "lib");

if (resolve(lib) !== join(pluginRoot, "lib") || dirname(lib) !== pluginRoot) throw new Error('Invalid plugin build directory');
await rm(lib, { recursive: true, force: true });
await mkdir(join(lib, "client"), { recursive: true });
await copyFile(join(workspaceRoot, 'docs/deployment/independent-components.md'), join(lib, 'INSTALL.md'));
await copyFile(join(workspaceRoot, 'docs/adapters/independent-adapter-authoring.md'), join(lib, 'ADAPTER-AUTHORING.md'));
await build({ entryPoints: [join(pluginRoot, "src", "business-pages-api.ts")], outfile: join(lib, "business-pages.js"), bundle: true, format: "esm", platform: "neutral" });
await writeBusinessPageDeclarations(workspaceRoot, lib);

await build({
  absWorkingDir: workspaceRoot,
  entryPoints: ["plugins/dsh-session-maintenance/src/index.ts"],
  outfile: join(lib, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  conditions: ["development"],
  external: ["@deepseek-ai/*"],
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
  external: ["react", "react/jsx-runtime"],
  legalComments: "none",
  banner: {
    js: 'window.__ModuleLoader__.load({ id: "dsh-session-maintenance", factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: "return module.exports;\n}});" },
});

await copyFile(join(workspaceRoot, "packages", "dsh-core-extension", "dist", "dsh-015-host.js"), join(lib, "dsh-015-host.js"));
const normalizedHash = bytes => 'sha256:' + createHash('sha256').update(bytes.toString('utf8').replaceAll('\r\n', '\n')).digest('hex');
await writeFile(join(lib, 'dsh-015-host.build.json'), JSON.stringify({
  sourceHash: normalizedHash(await readFile(join(workspaceRoot, 'packages/dsh-core-extension/src/dsh-015-host.ts'))),
  artifactHash: normalizedHash(await readFile(join(lib, 'dsh-015-host.js'))),
}));
await build({ entryPoints: [join(pluginRoot, 'scripts/verify-installation.mjs')], outfile: join(lib, 'verify-installation.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24', conditions: ['development'], plugins: [dshRc2PackageMetadata()],
  banner: { js: 'import {createRequire as verificationRequire} from "node:module"; const require=verificationRequire(import.meta.url);' } });
await writeFile(join(lib, "index.d.ts"), "export declare const name = \"dsh-session-maintenance\";\nexport declare function apply(ctx: unknown, config: unknown): void;\n");
await writeFile(join(lib, "client", "index.d.ts"), "export declare function apply(ctx: unknown): void;\n");

// The same release supplies host UI and the matching offline Engine codec.
for (const [source, output] of [['index.ts', 'index.mjs'], ['rpc-worker.ts', 'rpc-worker.mjs']]) {
  await build({ absWorkingDir: workspaceRoot, entryPoints: [join('packages/adapter-dsh-0-1-5/src', source)],
    outfile: join(lib, 'adapter', output), bundle: true, platform: 'node', format: 'esm', target: 'node24',
    conditions: ['development'], legalComments: 'none', plugins: [dshRc2PackageMetadata()],
    banner: { js: 'import { createRequire as adapterRequire } from "node:module"; const require = adapterRequire(import.meta.url);' } });
}
const metadata = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'));
await writeFile(join(pluginRoot, 'maintenance-adapter.json'), JSON.stringify({
  protocolVersion: 1, packageId: metadata.name, version: metadata.version,
  entries: [{ kind: 'instance', id: 'dsh-0.1.5', engine: 'lib/adapter/index.mjs', worker: 'lib/adapter/rpc-worker.mjs', dsh: 'lib/index.js' }],
}, null, 2) + '\n');
