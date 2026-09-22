import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, access, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectDsh015CoreBindingReceipt } from '@linmu/dsh-core-extension';
import { standaloneInstanceSchema } from '@linmu/dsh-session-contracts';
import { REQUIRED_CAPABILITIES } from '../../../packages/adapter-dsh-0-1-5/src/probe.ts';

import { inspectDshIntegrationPlugin } from '../../../packages/instance-integration-dsh/src/launcher-discovery.ts';

const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!['--config', '--engine', '--engine-version', '--out-dir', '--launcher-digest', '--profile-dir'].includes(key) || !value || options.has(key)) throw new Error('Usage: node verify-installation.mjs --config instance.json --engine engine.mjs --engine-version VERSION --out-dir PROFILE [--profile-dir NAME] [--launcher-digest SHA256]');
  options.set(key, value);
}
for (const key of ['--config', '--engine', '--engine-version', '--out-dir']) if (!options.has(key)) throw new Error(`Missing ${key}`);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const config = standaloneInstanceSchema.parse(await json(resolve(options.get('--config'))));
assert.equal(config.runtimeVersion, '0.1.5-rc.2', 'This adapter verifies DSH 0.1.5-rc.2 only');
// The profile *directory* and the instance's declared Maintenance identity are two different
// names: the directory is a path segment (`profiles/web`), while `profileId` is what the plugin
// declares in its patch row and what the Engine matches instances by. The receipt must state the
// declared identity — that is the half the Engine compares — so the directory can be named on its
// own for a machine where the two differ.
const profileDirectory = options.get('--profile-dir') ?? config.profileId;
const homeRoot = await realpath(config.homeRoot), profileRoot = await realpath(join(homeRoot, 'profiles', profileDirectory));
const profile = await json(join(profileRoot, 'package.json'));
if (profile.dsh?.profile?.bundles?.includes('dsh-gpt-compat')) throw new Error('This standard probe excludes experimental GPT Compat; use that extension\'s dedicated conformance suite.');
let cliRoot = join(config.versionRoot, 'apps', 'cli');
try { await readFile(join(cliRoot, 'package.json')); } catch { cliRoot = join(config.versionRoot, 'node_modules', '@deepseek-ai', 'dsh'); }
const pluginCheck = await inspectDshIntegrationPlugin({ cliManifest: join(cliRoot, 'package.json'), profileManifest: join(profileRoot, 'package.json'), roots: [homeRoot, config.versionRoot], hostVersion: config.runtimeVersion });
if (!pluginCheck.ready) throw new Error(`${pluginCheck.issue.code}: ${pluginCheck.issue.message}`);
// Match the installed plugin's actual importer, including its pnpm peer closure.
const selectedRequire = createRequire(pluginCheck.plugin.path);
const anchor = await realpath(selectedRequire.resolve('dsh-session-maintenance')), require = createRequire(anchor);
// Parsing the bundle is insufficient: bundled CommonJS dependencies must load under Node ESM.
const hostModule = await import(pathToFileURL(anchor).href);
assert.equal(typeof hostModule.apply, 'function', 'Installed Maintenance host module must load');
const entry = await realpath(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl'));
const backendRequire = createRequire(entry);
const { Context } = await import(pathToFileURL(backendRequire.resolve('@deepseek-ai/cordis')).href);
const { default: Backend } = await import(pathToFileURL(entry).href);
const root = await mkdtemp(join(tmpdir(), 'SYNTHETIC-maintenance-install-probe-'));
let handle;
try {
  await writeFile(join(root, 'SYNTHETIC'), 'Installation capability probe; never a user session.');
  const context = new Context(), backend = new Backend(context, { root: join(root, 'sessions') });
  for (const method of ['stat', 'list', 'open', 'create']) assert.equal(typeof backend[method], 'function', `Missing persistence.${method}`);
  const header = { version: 3, id: 'maintenance-install-probe', cwd: root, createdAt: Date.now(), delegationDepth: 0, agentPreset: 'standard', isSeeded: false };
  handle = await backend.create(header);
  for (const method of ['read', 'append', 'flush', 'close']) assert.equal(typeof handle[method], 'function', `Missing handle.${method}`);
  const event = { type: 'permission/preset', seq: 0, time: header.createdAt, data: { preset: 'default' } };
  await handle.append([event]); await handle.flush(); await handle.close(); handle = undefined;
  assert.ok(await backend.stat(header.id));
  handle = await backend.open(header.id, 'read');
  assert.deepEqual((await handle.read()).events, [event]);
  await assert.rejects(() => handle.append([event]), /read.only|readonly|read-only|write/i);
  await handle.close(); handle = undefined;

  const library = dirname(fileURLToPath(import.meta.url));
  const materialization = await json(join(library, 'dsh-015-host.build.json'));
  assert.equal('sha256:' + hash(Buffer.from((await readFile(join(library, 'dsh-015-host.js'), 'utf8')).replaceAll('\r\n', '\n'))), materialization.artifactHash);
  const binding = await collectDsh015CoreBindingReceipt({ importAnchor: anchor, materialization,
    sessionFormat: { adapterId: 'dsh-0.1.5', formatId: 'dsh-0.1.5-v3-jsonl-zstd-v1', extensions: [] } });
  const out = resolve(options.get('--out-dir'));
  await mkdir(out, { recursive: true });
  const bindingPath = join(out, 'maintenance-core-binding.json');
  const receiptPath = join(out, 'maintenance-runtime-attestation.json');
  for (const path of [bindingPath, receiptPath]) {
    try { await access(path); throw new Error(`Receipt already exists: ${path}. Keep it as a backup before running a new verification.`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const bindingBytes = Buffer.from(JSON.stringify(binding, null, 2) + '\n');
  assert.equal((await json(join(cliRoot, 'package.json'))).version, config.runtimeVersion);
  const artifacts = { cli: join(cliRoot, 'lib', 'bin.js'), node: process.execPath,
    session: binding.packages['@deepseek-ai/dsh-session'].entryPath,
    sessionPersistence: binding.packages['@deepseek-ai/dsh-session-persistence'].entryPath,
    formatCatalog: binding.packages['@deepseek-ai/dsh-session-format-catalog'].entryPath,
    maintenancePlugin: anchor, maintenancePluginManifest: pluginCheck.plugin.path, engine: resolve(options.get('--engine')) };
  for (const [name, pin] of Object.entries(binding.packages)) { artifacts[`manifest:${name}`] = pin.manifestPath; artifacts[`entry:${name}`] = pin.entryPath; }
  const files = await Promise.all(Object.entries(artifacts).map(async ([role, value]) => { const path = await realpath(value); return { role, path, sha256: hash(await readFile(path)) }; }));
  files.push({ role: 'coreBindingReceipt', path: join(await realpath(out), 'maintenance-core-binding.json'), sha256: hash(bindingBytes) });
  const launcherCapabilityDigest = options.get('--launcher-digest') ?? null;
  if (launcherCapabilityDigest !== null && !/^[a-f0-9]{64}$/u.test(launcherCapabilityDigest)) throw new Error('Invalid Launcher capability digest');
  const receipt = { schemaVersion: 1, instanceId: config.instanceId, profileId: config.profileId, homeRoot,
    adapterId: 'dsh-0.1.5', formatId: 'dsh-0.1.5-v3-jsonl-zstd-v1', runtimeVersion: config.runtimeVersion,
    engineVersion: options.get('--engine-version'), launcherCapabilityDigest, runtimeCapabilities: [...REQUIRED_CAPABILITIES], files };
  await writeFile(bindingPath, bindingBytes, { flag: 'wx' });
  try { await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) { await unlink(bindingPath); throw error; }
  console.log(JSON.stringify({ compatible: true, out, runtimeVersion: config.runtimeVersion, capabilities: receipt.runtimeCapabilities }));
} finally {
  await handle?.close();
  assert.ok(basename(root).startsWith('SYNTHETIC-maintenance-install-probe-'));
  await rm(root, { recursive: true, force: true });
}
