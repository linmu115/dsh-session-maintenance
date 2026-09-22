// Source-only release: no installed generations, user configuration, tokens or session content.
import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deterministicTarGz, sha256 } from './phase2-pack-lib.mjs';
import { dshRc2PackageMetadata } from './dsh-rc2-bundle-plugin.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), i = args.indexOf('--out');
if (i < 0 || !args[i + 1]) throw new Error('Missing --out');
const out = resolve(args[i + 1]); await mkdir(dirname(out), { recursive: true }); await mkdir(out);
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const bundle = (entryPoints, outfile, extra = {}) => build({ absWorkingDir: root, entryPoints, outfile, bundle: true,
  platform: 'node', format: 'esm', target: 'node24', conditions: ['development'], legalComments: 'none',
  plugins: [dshRc2PackageMetadata()], banner: { js: 'import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);' }, ...extra });
await bundle(['apps/engine/src/main.ts'], join(out, 'engine/dsh-session-maint.mjs'));
for (const [source, name] of [['adapter-dsh-alpha2', 'dsh-alpha2'], ['adapter-dsh-rc1', 'dsh-rc1'], ['adapter-dsh-rc2', 'dsh-rc2'], ['extension-gpt-compat', 'dsh-0-1-5']])
  await bundle([`packages/${source}/src/rpc-worker.ts`], join(out, `engine/adapters/${name}-rpc-worker.mjs`));
await cp(join(root, 'apps/dashboard/dist'), join(out, 'dashboard'), { recursive: true });
await cp(join(root, 'scripts/windows-maintenance'), join(out, 'windows-maintenance'), { recursive: true });
const pluginSource = join(root, 'plugins/dsh-session-maintenance'), unpacked = join(out, 'unpacked/dsh-session-maintenance');
await mkdir(unpacked, { recursive: true });
const plugin = await json(join(pluginSource, 'package.json')); delete plugin.devDependencies; delete plugin.scripts; delete plugin.packageManager;
for (const file of ['lib', 'maintenance-adapter.json', 'cordis.patch.yml', 'dsh-management', 'README.md', 'LICENSE'])
  await cp(join(pluginSource, file), join(unpacked, file), { recursive: true, filter: path => !path.endsWith('.map') });
await save(join(unpacked, 'package.json'), plugin);
await mkdir(join(out, 'packages')); const archive = await deterministicTarGz(unpacked, 'package');
await writeFile(join(out, `packages/dsh-session-maintenance-${plugin.version}.tgz`), archive);
await writeFile(join(out, 'engine/dsh-session-maintenance.tgz'), archive);
await save(join(out, 'engine/integration-package.json'), { schemaVersion: 1, file: 'dsh-session-maintenance.tgz', sha256: sha256(archive).slice(7) });
const entries = [];
for (const [name, namespace] of [['thoughtDagAdapter','thoughtdag'], ['upstreamAdapter','annotation-upstream'], ['annotationRecordsAdapter','annotation-records'],
  ['nativeContextAdapter','annotation-context'], ['obsidianLinksAdapter','obsidian-links'], ['stickerAdapter','stickers']]) {
  await bundle(undefined, join(out, `adapters/lynn/${namespace}.mjs`), { stdin: { contents: `export { ${name} as adapter } from './packages/adapter-lynn/src/legacy.ts';`, resolveDir: root, sourcefile: namespace + '.ts' } });
  entries.push({ kind: 'business', id: namespace, namespace, engine: namespace + '.mjs' });
}
await save(join(out, 'adapters/lynn/maintenance-adapter.json'), { protocolVersion: 1, packageId: 'lynn-adapter', version: '0.1.0', entries });
await bundle(undefined, join(out, 'adapters/gpt-compat/index.mjs'), { stdin: { contents: "export { gptCompatExtensionAdapter as adapter } from './packages/extension-gpt-compat/src/index.ts';", resolveDir: root, sourcefile: 'gpt-adapter.ts' } });
await save(join(out, 'adapters/gpt-compat/maintenance-adapter.json'), { protocolVersion: 1, packageId: 'gpt-compat-adapter', version: '0.1.0',
  entries: [{ kind: 'business', id: 'gpt-compat', namespace: 'gpt-compat', engine: 'index.mjs' }] });
await cp(join(root, 'docs/changes/2026-09-22-lynn-and-gpt-adapters.md'), join(out, 'README.md'));
const files = {};
async function hashTree(dir) { for (const f of await readdir(dir, { withFileTypes: true })) { const path = join(dir, f.name);
  if (f.isSymbolicLink()) throw new Error('Release symlink'); if (f.isDirectory()) await hashTree(path); else files[relative(out, path).replaceAll('\\','/')] = sha256(await readFile(path)); } }
await hashTree(out);
const engine = await json(join(root, 'apps/engine/package.json'));
await save(join(out, 'BUILD-INFO.json'), { schemaVersion: 1, status: 'candidate-not-installed', engineVersion: engine.version,
  protocolVersions: { externalLifecycle: 1 }, components: [{ name: engine.name, version: engine.version }, { name: plugin.name, version: plugin.version }],
  adapters: ['Lynn adapter', 'gpt-compat'], includesUserData: false, includesCredentials: false, files });
console.log(JSON.stringify({ out, engineVersion: engine.version, pluginVersion: plugin.version, files: Object.keys(files).length }));
