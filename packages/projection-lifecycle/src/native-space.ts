import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { DshSessionAdapterV1, JsonValue, NativeSessionCodec, ProjectionRun, ProjectionRunRepository } from "@linmu/dsh-session-contracts";
import { JsonProjectionDirectory } from "./materialize.js";

interface FileState { readonly digest: string | null; readonly path: string; readonly identity: string; }
interface SpaceManifest {
  readonly schemaVersion: 1;
  readonly key: string;
  readonly owner: string;
  readonly state: "preparing" | "ready" | "clean";
  readonly files: Readonly<Record<string, FileState>>;
}
interface Replacement { readonly path: string; readonly staged: string; readonly hash: string; readonly previous: string | null; }
interface SyncJournal {
  readonly schemaVersion: 1;
  readonly replacements: readonly Replacement[];
  readonly deletions: readonly { readonly path: string; readonly identity: string }[];
  readonly next: SpaceManifest;
}
export interface NativeSpaceReference { readonly schemaVersion: 1; readonly key: string; readonly root: string; }
const hash = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex");
function structuredDigest(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, child]) => [k, canonical(child)])) : v;
  return hash(JSON.stringify(canonical(value)));
}
const obj = (value: JsonValue): Readonly<Record<string, JsonValue>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid native-space payload");
  return value as Readonly<Record<string, JsonValue>>;
};

export function nativeSpaceReference(runtimeRoot: string, run: ProjectionRun, codec: NativeSessionCodec): NativeSpaceReference {
  const key = hash(JSON.stringify([run.instanceId, run.profileId, run.branchId, run.adapterId, codec.formatId]));
  return { schemaVersion: 1, key, root: join(resolve(runtimeRoot), "native-spaces", key, "sessions") };
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function durableWrite(path: string, value: Uint8Array): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const pending = `${path}.${randomUUID()}.tmp`;
  try { await durableWrite(pending, Buffer.from(`${JSON.stringify(value)}\n`)); await rename(pending, path); }
  finally { await unlink(pending).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
}

/** Checks each existing ancestor before file mutation; no adapter-relative path can escape the space. */
async function ownedPath(root: string, child: string): Promise<string> {
  const target = resolve(root, child);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new TypeError("Native artifact path escapes its space");
  let current = target;
  for (;;) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new TypeError("Native space contains a link"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (current === resolve(root)) break;
    current = dirname(current);
  }
  return target;
}

async function identity(path: string): Promise<string | null> {
  try {
    const s = await lstat(path, { bigint: true });
    if (!s.isFile() || s.isSymbolicLink()) throw new TypeError("Native artifact is not a regular file");
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** One stable space, with a forward-only journal. Caller holds the canonical branch writer lease. */
export class NativeSessionSpace {
  readonly reference: NativeSpaceReference;
  private readonly control: string;
  constructor(private readonly runtimeRoot: string, private readonly run: ProjectionRun,
    private readonly adapter: DshSessionAdapterV1, private readonly runs: ProjectionRunRepository) {
    if (!adapter.nativeSessionCodec) throw new TypeError("Adapter has no native-file capability");
    this.reference = nativeSpaceReference(runtimeRoot, run, adapter.nativeSessionCodec);
    this.control = dirname(this.reference.root);
  }
  private get codec() { return this.adapter.nativeSessionCodec!; }
  private get manifestPath() { return join(this.control, "space.json"); }
  private get journalPath() { return join(this.control, "sync.json"); }

  private async manifest(): Promise<SpaceManifest | undefined> {
    const m = await readJson<SpaceManifest>(this.manifestPath);
    if (m && (m.schemaVersion !== 1 || m.key !== this.reference.key || !["preparing", "clean", "ready"].includes(m.state)
      || typeof m.owner !== "string" || !m.files || typeof m.files !== "object")) throw new TypeError("Invalid native space manifest");
    if (m) for (const f of Object.values(m.files)) {
      if (!f || typeof f.path !== "string" || typeof f.identity !== "string"
        || !(f.digest === null || typeof f.digest === "string")) throw new TypeError("Invalid native file manifest");
    }
    return m;
  }

  private async ownerIsFinished(owner: string): Promise<void> {
    if (owner === this.run.id) return;
    const previous = await this.runs.getProjectionRun(owner as ProjectionRun["id"]);
    if (!previous || !["closed", "recovered"].includes(previous.state)) throw new Error("Native space requires previous run recovery");
  }

  async prepare(directory: JsonProjectionDirectory): Promise<NativeSpaceReference> {
    await ownedPath(resolve(this.runtimeRoot), relative(resolve(this.runtimeRoot), this.reference.root));
    await mkdir(this.reference.root, { recursive: true });
    const journal = await readJson<SyncJournal>(this.journalPath);
    if (journal) {
      // No host can start before prepare returns. A retained journal is always a pre-host transaction.
      const previous = await this.runs.getProjectionRun(journal.next.owner as ProjectionRun["id"]);
      if (journal.next.owner !== this.run.id && (!previous || !["quarantined", "recovered", "closed"].includes(previous.state))) {
        throw new Error("Native sync transaction is owned by another run");
      }
      await this.commitJournal(journal);
    }
    const old = await this.manifest();
    if (old) {
      if (old.state !== "clean") {
        const previous = await this.runs.getProjectionRun(old.owner as ProjectionRun["id"]);
        if (old.state !== "preparing" || (old.owner !== this.run.id && previous?.state !== "quarantined")) {
          throw new Error("Native space is not safely closed");
        }
      } else await this.ownerIsFinished(old.owner);
    } else if ((await readdir(this.reference.root)).length !== 0) throw new Error("Refusing unowned native files");
    await this.verifyInventory(old?.files ?? {});
    // Staging has no history semantics. Once the prior journal is completed and ownership
    // is checked, leftovers from failures before journal publication are safe to remove.
    for (const name of await readdir(this.control)) {
      if (/^[a-f0-9-]+\.native$/u.test(name)) await unlink(await ownedPath(this.control, name));
    }
    const manifest = await directory.readManifest();
    const catalog = await directory.readSessionCatalog(this.run.id);
    const next: Record<string, FileState> = {};
    const replacements: Replacement[] = [];
    const desired = new Set<string>();
    const normalized = [];
    for (const item of catalog.sessions) {
      const description = await this.codec.describe(item.payload, this.reference.root);
      const path = await ownedPath(this.reference.root, description.relativePath);
      if (desired.has(path.toLowerCase())) throw new TypeError("Native artifact path collision");
      desired.add(path.toLowerCase());
      const digest = structuredDigest([manifest.sessionDigests[item.nativeSessionId], this.adapter.manifest.packageVersion, description]);
      const prior = old?.files[item.nativeSessionId];
      const actual = await identity(path);
      if (prior && prior.path === description.relativePath && prior.identity !== actual) throw new Error("Native file changed after checkpoint");
      if (actual !== null && (!prior || prior.path !== description.relativePath)) throw new Error("Refusing to overwrite an unowned native file");
      if (prior?.digest === digest && prior.path === description.relativePath && actual !== null) {
        next[item.nativeSessionId] = prior;
      } else {
        const payload = await directory.readSession(item.nativeSessionId);
        const bytes = this.codec.encode(payload, description);
        const staged = `${randomUUID()}.native`;
        await durableWrite(join(this.control, staged), bytes);
        replacements.push({ path: description.relativePath, staged, hash: hash(bytes), previous: actual });
        next[item.nativeSessionId] = { digest, path: description.relativePath, identity: "pending" };
      }
      normalized.push({ ...item, payload: { ...obj(item.payload), header: description.header } });
    }
    const deletions = Object.values(old?.files ?? {}).filter(f => !desired.has(resolve(this.reference.root, f.path).toLowerCase()))
      .map(f => ({ path: f.path, identity: f.identity }));
    const transaction: SyncJournal = { schemaVersion: 1, replacements, deletions,
      next: { schemaVersion: 1, key: this.reference.key, owner: this.run.id, state: "preparing", files: next } };
    await atomicJson(this.journalPath, transaction);
    await this.commitJournal(transaction);
    await directory.replaceSessionCatalog({ ...catalog, sessions: normalized });
    await atomicJson(this.manifestPath, { ...await this.manifest(), state: "ready" });
    return this.reference;
  }

  /** Finish a pre-host transaction before inspecting native tails during recovery. */
  async recoverPreparation(directory: JsonProjectionDirectory): Promise<void> {
    const m = await this.manifest();
    if (m?.owner === this.run.id && m.state !== "preparing" && !await readJson(this.journalPath)) return;
    await this.prepare(directory);
  }

  private async verifyInventory(files: Readonly<Record<string, FileState>>): Promise<void> {
    const expected = new Set(Object.values(files).map(f => resolve(this.reference.root, f.path).toLowerCase()));
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const path = await ownedPath(this.reference.root, relative(this.reference.root, join(folder, entry.name)));
        if (entry.isDirectory()) await walk(path);
        else if (!entry.isFile() || !expected.has(path.toLowerCase())) throw new Error("Refusing unowned native files");
      }
    };
    await walk(this.reference.root);
  }

  private async commitJournal(j: SyncJournal): Promise<void> {
    if (j.schemaVersion !== 1 || j.next.key !== this.reference.key || !Array.isArray(j.replacements) || !Array.isArray(j.deletions)) {
      throw new TypeError("Invalid native sync journal");
    }
    const files: Record<string, FileState> = { ...j.next.files };
    for (const change of j.replacements) {
      if (!/^[a-f0-9-]+\.native$/u.test(change.staged)) throw new TypeError("Invalid native staging file");
      const path = await ownedPath(this.reference.root, change.path);
      const staged = await ownedPath(this.control, change.staged);
      let bytes: Buffer | undefined;
      try { bytes = await readFile(staged); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (bytes) {
        if (hash(bytes) !== change.hash || await identity(path) !== change.previous) throw new Error("Native sync file identity changed");
        await mkdir(dirname(path), { recursive: true });
        await rename(staged, path);
      } else if (hash(await readFile(path)) !== change.hash) throw new Error("Interrupted native replacement cannot be verified");
    }
    for (const deletion of j.deletions) {
      const path = await ownedPath(this.reference.root, deletion.path);
      const actual = await identity(path);
      if (actual !== null) {
        if (actual !== deletion.identity) throw new Error("Native deletion target changed");
        await unlink(path);
      }
      for (const folder of [dirname(path), dirname(dirname(path))]) {
        if (folder === this.reference.root) break;
        await rmdir(folder).catch((error: NodeJS.ErrnoException) => { if (!["ENOENT", "ENOTEMPTY"].includes(error.code ?? "")) throw error; });
      }
    }
    for (const [id, state] of Object.entries(files)) {
      const current = await identity(await ownedPath(this.reference.root, state.path));
      if (current === null) throw new Error("Native space is incomplete");
      files[id] = { ...state, identity: current };
    }
    await atomicJson(this.manifestPath, { ...j.next, files });
    await unlink(this.journalPath);
  }

  /** Called only after native tail recovery / official flush and canonical checkpoint succeed. */
  async checkpoint(directory: JsonProjectionDirectory, refreshedCache?: JsonProjectionDirectory, refresh?: () => Promise<void>): Promise<void> {
    const m = await this.manifest();
    if (!m || m.owner !== this.run.id) throw new Error("Native checkpoint owner mismatch");
    const manifest = await directory.readManifest();
    const catalog = await directory.readSessionCatalog(this.run.id);
    const mappings = await (this.runs as ProjectionRunRepository & {
      listProjectionSessions?: (id: ProjectionRun["id"]) => Promise<readonly { nativeSessionId: string }[]>;
    }).listProjectionSessions?.(this.run.id);
    const ids = mappings?.map(s => s.nativeSessionId) ?? catalog.sessions.map(s => s.nativeSessionId);
    const metadata = new Map<string, { payload: JsonValue }>();
    for (const id of ids) {
      const item = catalog.sessions.find(s => s.nativeSessionId === id);
      metadata.set(id, item ?? { payload: await directory.readSession(id as never) });
    }
    const files: Record<string, FileState> = {};
    const artifacts = await this.codec.inspect(this.reference.root);
    for (const artifact of artifacts) {
      const item = metadata.get(artifact.nativeSessionId);
      let digest: string | null = null;
      if (!item) {
        if (!this.codec.isPreparationOnly(artifact.events)) throw new Error(`Unregistered native history requires recovery: ${artifact.nativeSessionId}`);
      } else {
        const payload = obj(await directory.readSession(artifact.nativeSessionId));
        const events = payload.events as readonly JsonValue[];
        const expected = (await this.codec.describe(item.payload, this.reference.root)).header;
        const originalHeader = { ...obj(payload.header!), delegationDepth: obj(payload.header!).delegationDepth ?? 0 };
        if ((!isDeepStrictEqual(artifact.header, expected) && !isDeepStrictEqual(artifact.header, originalHeader))
          || artifact.inheritedEventCount !== Number(payload.inheritedEventCount ?? 0)
          || !isDeepStrictEqual(artifact.events.slice(0, events.length), events)
          || !this.codec.isPreparationOnly(artifact.events.slice(events.length))) throw new Error("Native history is not fully committed");
        if (artifact.complete && artifact.events.length === events.length) {
          const sourceDigest = manifest.sessionDigests[artifact.nativeSessionId];
          if (sourceDigest) digest = structuredDigest([sourceDigest, this.adapter.manifest.packageVersion,
            { relativePath: artifact.relativePath, header: artifact.header }]);
        }
        metadata.delete(artifact.nativeSessionId);
      }
      const path = await ownedPath(this.reference.root, artifact.relativePath);
      files[artifact.nativeSessionId] = { digest, path: artifact.relativePath, identity: (await identity(path))! };
    }
    if (metadata.size !== 0) throw new Error("Native checkpoint is missing committed sessions");
    // Validate the pinned run BEFORE refreshing its shared base, which can advance
    // independently (for example, a Codex source changed while DSH was running).
    await refresh?.();
    if (refreshedCache) {
      const cacheManifest = await refreshedCache.readManifest();
      for (const artifact of artifacts) {
        let digest: string | null = null;
        const sourceDigest = cacheManifest.sessionDigests[artifact.nativeSessionId];
        if (sourceDigest && artifact.complete) {
          const cached = obj(await refreshedCache.readSession(artifact.nativeSessionId));
          const description = await this.codec.describe(cached, this.reference.root);
          if (isDeepStrictEqual(cached.events, artifact.events) && isDeepStrictEqual(description.header, artifact.header)
            && description.relativePath === artifact.relativePath) {
            digest = structuredDigest([sourceDigest, this.adapter.manifest.packageVersion, description]);
          }
        }
        files[artifact.nativeSessionId] = { ...files[artifact.nativeSessionId]!, digest };
      }
    }
    await atomicJson(this.manifestPath, { ...m, state: "clean", files });
  }
}
