// Build from explicit source trees. Never read an installed generation or user state.
import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deterministicTarGz, sha256 } from './phase2-pack-lib.mjs';
import { dshRc2PackageMetadata } from './dsh-rc2-bundle-plugin.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argument = name => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`Missing ${name}`); return resolve(args[i + 1]); };
const out = argument('--out'), sources = JSON.parse(await readFile(argument('--sources'), 'utf8'));
await mkdir(out); // Refuse to overwrite an existing release.
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const copy = (from, to) => cp(from, to, { recursive: true, filter: path => !path.endsWith('.map') });
// Bundler region labels can contain absolute virtual CSS module IDs from the build machine.
// Remove only generated region comments; executable code and license notices are unchanged.
const stripBuildRegions = async directory => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await stripBuildRegions(path);
    else if (/\.[cm]?js$/.test(entry.name)) {
      const original = await readFile(path, 'utf8');
      const cleaned = original.replace(/^[\t ]*\/\/#(?:end)?region[^\r\n]*(?:\r?\n|$)/gm, '');
      if (cleaned !== original) await writeFile(path, cleaned);
    }
  }
};
const nodeBuild = (entryPoints, outfile, extra = {}) => build({ absWorkingDir: root, entryPoints, outfile,
  bundle: true, platform: 'node', format: 'esm', target: 'node24', conditions: ['development'], legalComments: 'none',
  plugins: [dshRc2PackageMetadata()], banner: { js: 'import {createRequire as bundleRequire} from "node:module"; const require=bundleRequire(import.meta.url);' }, ...extra });
await nodeBuild(['apps/engine/src/main.ts'], join(out, 'engine/dsh-session-maint.mjs'));
for (const [source, name] of [['adapter-dsh-alpha2','dsh-alpha2'],['adapter-dsh-rc1','dsh-rc1'],['adapter-dsh-rc2','dsh-rc2'],['extension-gpt-compat','dsh-0-1-5']])
  await nodeBuild([`packages/${source}/src/rpc-worker.ts`], join(out, `engine/adapters/${name}-rpc-worker.mjs`));
await copy(join(root, 'apps/dashboard/dist'), join(out, 'dashboard'));
await mkdir(join(out, 'packages'));
await mkdir(join(out, 'unpacked'));

const packages = [
  { path: join(root, 'plugins/dsh-session-maintenance'), paths: ['lib','cordis.patch.yml','maintenance-adapter.json','README.md','LICENSE','dsh-management'] },
  { path: resolve(sources.core), paths: ['lib','cordis.patch.yml','README.md','LICENSE'] },
  { path: resolve(sources.bridge), paths: ['dist','cordis.patch.yml','README.md','LICENSE'] },
  { path: resolve(sources.sticker), paths: ['lib','cordis.patch.yml','README.md','LICENSE'] },
  { path: resolve(sources.dag), paths: ['lib','dist-app','cordis.patch.yml','README.md','MANAGED.md','LICENSE'] },
  { path: resolve(sources.companion), paths: ['main.js','styles.css','manifest.json','versions.json','README.md','LICENSE'] },
  { path: join(root, 'packages/contracts'), paths: ['dist'] },
  { path: join(root, 'packages/session-adapter-sdk'), paths: ['dist'] },
];
const versions = new Map(await Promise.all(packages.map(async item => { const m = await json(join(item.path, 'package.json')); return [m.name, m.version]; })));
const packaged = [];
for (const item of packages) {
  const manifest = await json(join(item.path, 'package.json'));
  const directory = join(out, 'unpacked', manifest.name.replace(/^@/, '').replaceAll('/', '-'));
  await mkdir(directory);
  for (const path of item.paths) await copy(join(item.path, path), join(directory, path));
  if (['dsh-session-maintenance','dsh-annotation-core','dsh-obsidian-bridge','dsh-session-sticker-board','obsidian-deepharness-bridge'].includes(manifest.name))
    await copy(join(manifest.name === 'dsh-session-maintenance' ? root : item.path, 'docs/changes/2026-09-20-independent-components.md'), join(directory, 'docs/changes/2026-09-20-independent-components.md'));
  manifest.private = false;
  delete manifest.devDependencies; delete manifest.scripts; delete manifest.packageManager;
  for (const field of ['dependencies','optionalDependencies','peerDependencies']) {
    for (const [name, value] of Object.entries(manifest[field] ?? {})) {
      if (value.startsWith('workspace:')) {
        if (!versions.has(name)) throw new Error(`Unpackaged workspace dependency: ${name}`);
        manifest[field][name] = versions.get(name);
      } else if (/^(link|file):/.test(value)) {
        // These SDK/protocol modules must be bundled. Verify no emitted runtime import remains.
        const emitted = [];
        const visit = async dir => { for (const f of await readdir(dir, { withFileTypes: true })) { const p = join(dir, f.name); if (f.isDirectory()) await visit(p); else if (/\.m?js$/.test(p)) emitted.push(await readFile(p, 'utf8')); } };
        await visit(directory);
        if (emitted.some(text => text.includes(`from "${name}`) || text.includes(`from '${name}`) || text.includes(`require("${name}`) || text.includes(`require('${name}`))) throw new Error(`Unbundled local dependency: ${manifest.name} -> ${name}`);
        delete manifest[field][name];
      }
    }
  }
  // Development export paths point to source which is deliberately absent from the runtime release.
  const strip = value => { if (value && typeof value === 'object') { delete value.development; for (const child of Object.values(value)) strip(child); } };
  strip(manifest.exports);
  await writeJson(join(directory, 'package.json'), manifest);
  await stripBuildRegions(directory);
  const filename = `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`;
  const bytes = await deterministicTarGz(directory, 'package');
  await writeFile(join(out, 'packages', filename), bytes);
  packaged.push({ name: manifest.name, version: manifest.version, artifact: `packages/${filename}`, sha256: sha256(bytes) });
  if (manifest.name === 'dsh-session-maintenance') {
    await writeFile(join(out, 'engine/dsh-session-maintenance.tgz'), bytes);
    await writeJson(join(out, 'engine/integration-package.json'), { schemaVersion: 1, file: 'dsh-session-maintenance.tgz', sha256: sha256(bytes).slice(7) });
  }
}

// The knowledge pack has independently switchable namespaces; it owns no database.
const knowledge = join(out, 'adapters', 'knowledge'); await mkdir(knowledge, { recursive: true });
const entries = [];
for (const [name, namespace] of [['thoughtDagAdapter','thoughtdag'],['upstreamAdapter','annotation-upstream'],['annotationRecordsAdapter','annotation-records'],['nativeContextAdapter','annotation-context'],['obsidianLinksAdapter','obsidian-links'],['stickerAdapter','stickers']]) {
  const engine = `${namespace}.mjs`;
  await nodeBuild(undefined, join(knowledge, engine), { stdin: { contents: `export { ${name} as adapter } from './packages/extension-knowledge/src/index.ts';`, resolveDir: root, sourcefile: `${namespace}.ts` } });
  entries.push({ kind: 'business', id: namespace, namespace, engine });
}
await writeJson(join(knowledge, 'maintenance-adapter.json'), { protocolVersion: 1, packageId: 'maintenance-knowledge', version: '0.1.0', entries });
await copy(join(root, 'docs/deployment/independent-components.md'), join(out, 'README.md'));
await copy(join(root, 'docs/adapters/independent-adapter-authoring.md'), join(out, 'ADAPTER-AUTHORING.md'));
const files = {};
const hashTree = async dir => { for (const f of await readdir(dir, { withFileTypes: true })) { const path = join(dir, f.name); if (f.isSymbolicLink()) throw new Error('Unexpected release symlink'); if (f.isDirectory()) await hashTree(path); else files[relative(out, path).replaceAll('\\','/')] = sha256(await readFile(path)); } };
await hashTree(out);
await writeJson(join(out, 'BUILD-INFO.json'), { schemaVersion: 1, engineVersion: (await json(join(root, 'apps/engine/package.json'))).version,
  status: 'candidate-not-installed', supportedStandardHost: '0.1.5-rc.2', packages: packaged,
  includesUserData: false, includesCredentials: false, files });
console.log(JSON.stringify({ out, packages: packaged, files: Object.keys(files).length }));
