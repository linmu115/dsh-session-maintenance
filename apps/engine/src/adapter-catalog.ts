import { mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { defineDshSessionAdapter, defineExtensionDataAdapter } from '@linmu/dsh-session-adapter-sdk';
import { adapterPackageSchema, type InstalledAdapterEntry, type ExtensionDataAdapter, type DshSessionAdapterV1 } from '@linmu/dsh-session-contracts';

async function json(path: string): Promise<unknown> { const text = await readFile(path, 'utf8'); if (Buffer.byteLength(text) > 256 * 1024) throw new Error('Adapter metadata exceeds 256 KiB'); return JSON.parse(text); }
async function contained(root: string, path: string) {
  const resolved = await realpath(join(root, path)), suffix = relative(root, resolved);
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) throw new Error('Adapter entry resolves outside its package');
  return resolved;
}
export class AdapterCatalog {
  private loadIssues: { directory: string; message: string }[] = [];
  constructor(private readonly stateRoot: string) {}
  private async enabled(): Promise<Set<string>> {
    const path = join(this.stateRoot, 'enabled-adapters.json');
    let value: unknown;
    try { value = await json(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set(); throw error; }
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Invalid enabled adapter configuration');
    return new Set(value);
  }
  /** Discovery only reads manifests. It does not evaluate third-party modules. */
  async discover() {
    const root = join(this.stateRoot, 'adapters'), enabled = await this.enabled();
    const entries: InstalledAdapterEntry[] = [], issues: { directory: string; message: string }[] = [];
    const directories = await readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const directory of directories.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      try {
        const location = await realpath(join(root, directory.name));
        const manifest = adapterPackageSchema.parse(await json(join(location, 'maintenance-adapter.json')));
        const packageEntries: InstalledAdapterEntry[] = [];
        for (const entry of manifest.entries) {
          if ([...entries, ...packageEntries].some(item => item.id === entry.id)) throw new Error(`Duplicate adapter ID: ${entry.id}`);
          packageEntries.push({ packageId: manifest.packageId, version: manifest.version, id: entry.id, kind: entry.kind,
            ...(entry.kind === 'business' ? { namespace: entry.namespace } : {}), enabled: enabled.has(entry.id), directory: location,
            engine: await contained(location, entry.engine), ...(entry.kind === 'instance' ? { worker: await contained(location, entry.worker) } : {}) });
          if (entry.kind === 'instance' && entry.dsh) await contained(location, entry.dsh);
        }
        entries.push(...packageEntries);
      } catch (error) { issues.push({ directory: directory.name, message: error instanceof Error ? error.message : 'Invalid adapter package' }); }
    }
    return { entries, issues: [...issues, ...this.loadIssues], requiresRestart: true };
  }
  async setEnabled(id: string, enabled: boolean) {
    if (!(await this.discover()).entries.some(entry => entry.id === id)) throw new Error('Adapter is not installed or its manifest is invalid');
    const active = await this.enabled(); if (enabled) active.add(id); else active.delete(id);
    await mkdir(this.stateRoot, { recursive: true });
    const target = join(this.stateRoot, 'enabled-adapters.json'), temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify([...active].sort(), null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, target);
    return { id, enabled, requiresRestart: true };
  }
  async load() {
    this.loadIssues = [];
    const catalog = await this.discover();
    const instances: { entry: InstalledAdapterEntry; adapter: DshSessionAdapterV1 }[] = [], business: ExtensionDataAdapter[] = [];
    for (const entry of catalog.entries.filter(entry => entry.enabled)) {
      try {
        const module = await import(pathToFileURL(entry.engine).href);
        const adapter = module.adapter ?? module.default;
        if (entry.kind === 'instance') {
          defineDshSessionAdapter(adapter);
          if (adapter?.manifest?.id !== entry.id) throw new Error('Instance entry manifest ID does not match its package');
          instances.push({ entry, adapter });
        } else {
          defineExtensionDataAdapter(adapter);
          if (adapter?.namespace !== entry.namespace || !Array.isArray(adapter.pluginVersions) || !Array.isArray(adapter.schemaVersions) || typeof adapter.validate !== 'function' || typeof adapter.summarize !== 'function' || adapter.capabilities?.context !== false) throw new Error('Business entry does not implement ExtensionDataAdapter');
          if (business.some(item => item.namespace === adapter.namespace)) throw new Error('Duplicate business namespace');
          business.push(adapter);
        }
      } catch (error) { const issue = { directory: entry.packageId, message: `${entry.id}: ${error instanceof Error ? error.message : 'Adapter load failed'}` }; catalog.issues.push(issue); this.loadIssues.push(issue); }
    }
    return { ...catalog, instances, business };
  }
}
