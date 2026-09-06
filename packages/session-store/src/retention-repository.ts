import { DatabaseSync } from "node:sqlite";
import { readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { RetentionBlocker, RetentionInventory, RetentionReference, RetentionResource, RetentionRoot, RetentionSource, RetentionVersion } from "@linmu/dsh-session-contracts";
import { checkedRetentionPath, identifyRetentionRoot, inventoryRetentionTree, isMissing, retentionDigest, retentionRelative } from "./retention-paths.js";
import { captureRetentionResources } from "./retention-resources.js";
import { ZstdContentObjectStore } from "./object-store.js";

type Row = Record<string, unknown>;
export type RetentionRows = Readonly<Record<string, readonly Row[]>>;
const REFERENCE_TABLES = ["session_versions", "version_metadata_snapshots", "version_parents", "logical_sessions", "workspace_memberships", "platform_bindings", "platform_refs", "native_mirrors", "checkpoints", "session_derivations", "session_tombstones", "projection_runs", "projection_sessions", "run_operations", "run_status_events", "continuation_jobs", "adapter_evidence", "sync_plans", "jobs", "transactions", "transaction_steps", "backup_manifests", "checkpoint_transactions"] as const;
export const retentionString = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
export function retentionRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a retention evidence object");
  return value as Record<string, unknown>;
}
export function retentionJson(value: unknown): unknown { if (typeof value !== "string") throw new Error("Expected JSON evidence"); return JSON.parse(value) as unknown; }

/** Registry writes are explicit. Engine calls them inside its MaintenanceWriteScope. */
export class RetentionRepository {
  constructor(readonly database: DatabaseSync, readonly activeDatabasePath: string) {}

  roots(): readonly RetentionRoot[] { return this.readRegistry<RetentionRoot>("retention_roots", "root_json"); }
  sources(): readonly RetentionSource[] { return this.readRegistry<RetentionSource>("retention_sources", "source_json"); }
  resources(): readonly RetentionResource[] { return this.readRegistry<RetentionResource>("retention_resources", "resource_json"); }
  private readRegistry<T>(table: string, column: string): readonly T[] {
    return this.database.prepare(`SELECT ${column} AS value FROM ${table} ORDER BY id`).all().map((row) => JSON.parse(String(row.value)) as T);
  }
  async registerRoot(id: string, path: string, purpose: RetentionRoot["purpose"]): Promise<RetentionRoot> {
    const root = await identifyRetentionRoot(id, path, purpose);
    const old = this.roots().find((entry) => entry.id === id);
    if (old && retentionDigest(old) !== retentionDigest(root)) throw new Error("A registered root cannot be silently rebound");
    this.database.prepare("INSERT INTO retention_roots(id, root_json) VALUES (?, ?) ON CONFLICT(id) DO NOTHING").run(id, JSON.stringify(root));
    return root;
  }
  registerSource(source: RetentionSource): void {
    retentionRelative(source.relativePath);
    if (!source.id.trim()) throw new TypeError("Source ID is required");
    const old = this.sources().find((entry) => entry.id === source.id);
    if (old && retentionDigest(old) !== retentionDigest(source)) throw new Error("Source registration is immutable; retirement requires governance");
    this.database.prepare("INSERT INTO retention_sources(id, root_id, object_root_id, source_json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
      .run(source.id, source.rootId, source.objectRootId, JSON.stringify(source));
  }
  registerResource(resource: RetentionResource): void {
    retentionRelative(resource.relativePath);
    if (!resource.id.trim() || resource.state !== "registered") throw new TypeError("New resource must be registered");
    const previous = this.resources().find((entry) => entry.id === resource.id);
    if (previous && (previous.rootId !== resource.rootId || previous.relativePath !== resource.relativePath || previous.ownerId !== resource.ownerId || previous.kind !== resource.kind || previous.state !== "registered")) throw new Error("Resource identity cannot be rebound");
    const root = this.roots().find((entry) => entry.id === resource.rootId);
    if (!root || root.purpose === "objects" || root.purpose === "state") throw new Error("Governed resources need a dedicated run/cache/backup/database root");
    const absolute = resolve(root.path, resource.relativePath);
    for (const other of this.resources().filter((entry) => entry.id !== resource.id && entry.state !== "purged")) {
      const otherRoot = this.roots().find((entry) => entry.id === other.rootId);
      if (!otherRoot) continue;
      const otherPath = resolve(otherRoot.path, other.relativePath);
      if (absolute === otherPath || absolute.startsWith(`${otherPath}/`) || otherPath.startsWith(`${absolute}/`) || !relative(absolute, otherPath).startsWith("..") || !relative(otherPath, absolute).startsWith("..")) throw new Error("Governed resources cannot overlap");
    }
    this.database.prepare("INSERT INTO retention_resources(id, root_id, resource_json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET resource_json=excluded.resource_json")
      .run(resource.id, resource.rootId, JSON.stringify(resource));
  }

  async capture(asOf: string): Promise<RetentionInventory> {
    if (!Number.isFinite(Date.parse(asOf)) || new Date(asOf).toISOString() !== asOf) throw new TypeError("Retention asOf must be an ISO UTC instant");
    const roots = this.roots(), sources = this.sources(), registered = this.resources();
    const blockers: RetentionBlocker[] = [], references: RetentionReference[] = [], versions: RetentionVersion[] = [];
    const sourceRevisions: Record<string, string> = {};
    const addBlock = (code: RetentionBlocker["code"], source: string, detail: string): void => { blockers.push({ code, source, detail }); };
    const validRoots = new Map<string, RetentionRoot>();
    for (const root of roots) try { await checkedRetentionPath(root); validRoots.set(root.id, root); } catch { addBlock("unsafe-path", root.id, "Registered root is unreadable, linked or replaced"); }
    if (!sources.some((source) => source.kind === "active-database" && source.retained)) addBlock("unregistered", "active-database", "The active database and its object store must be registered");
    let activeRows: RetentionRows = {};
    for (const source of sources.filter((entry) => entry.retained)) {
      let database: DatabaseSync | undefined;
      let external = false;
      try {
        const root = validRoots.get(source.rootId), objectRoot = validRoots.get(source.objectRootId);
        if (!root || !objectRoot || !["state", "objects"].includes(objectRoot.purpose)) throw new Error("Source has no verified object store");
        const path = await checkedRetentionPath(root, source.relativePath);
        if (source.kind === "unknown") { addBlock("unknown-format", source.id, "Unknown recovery database format"); continue; }
        if (source.kind === "active-database") {
          if (resolve(path) !== resolve(this.activeDatabasePath)) throw new Error("Active source does not identify the open database");
          database = this.database;
        } else { database = new DatabaseSync(path, { readOnly: true }); external = true; }
        const schema = Number(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version);
        if (![17, 19, 20].includes(schema)) { addBlock("unknown-format", source.id, `Unsupported reference schema ${schema}`); continue; }
        if (database.prepare("PRAGMA quick_check").all().some((row) => Object.values(row)[0] !== "ok") || database.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Database integrity check failed");
        const rows: Record<string, readonly Row[]> = {};
        // Reading all reference-bearing tables also detects changes that the catalog revision does not cover.
        database.exec("SAVEPOINT retention_read");
        try { for (const table of REFERENCE_TABLES) rows[table] = (database.prepare(`SELECT * FROM ${table}`).all() as Row[]).sort((a, b) => retentionDigest(a).localeCompare(retentionDigest(b))); }
        finally { database.exec("RELEASE retention_read"); }
        sourceRevisions[source.id] = retentionDigest({ schema, rows });
        if (!external) activeRows = rows;
        this.collectDatabaseReferences(source, rows, versions, references, addBlock);
      } catch { addBlock("unreadable", source.id, "Retained database reference coverage could not be verified"); }
      finally { if (external) database?.close(); }
    }
    // Detect recovery databases omitted from the registry. Never interpret an unknown candidate as zero references.
    const knownPaths = new Set(sources.map((source) => { const root = validRoots.get(source.rootId); return root ? resolve(root.path, source.relativePath) : ""; }));
    for (const root of validRoots.values()) if (["state", "databases", "backups"].includes(root.purpose)) {
      try {
        const files = await inventoryRetentionTree(root);
        for (const file of files) if (/\.(sqlite|sqlite3|db)$/iu.test(file.relativePath) && !knownPaths.has(resolve(root.path, file.relativePath))) {
          // Native transaction snapshots are governed by a verified backup manifest, not Maintenance SQL.
          const candidatePath = resolve(root.path, file.relativePath);
          const insideKnownBackup = registered.some((entry) => {
            const ownerRoot = validRoots.get(entry.rootId);
            if (!ownerRoot || entry.state === "purged" || entry.kind === "candidate") return false;
            const rel = relative(resolve(ownerRoot.path, entry.relativePath), candidatePath);
            return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && (entry.kind !== "backup" || entry.verifiedFingerprint !== null);
          });
          if (!insideKnownBackup) addBlock("unregistered", `${root.id}:${file.relativePath}`, "Unregistered database or recovery candidate");
        }
      } catch { addBlock("unsafe-path", root.id, "Discovery could not establish complete coverage under this root"); }
    }
    const objects: RetentionInventory["objects"][number][] = [];
    const physicalStores = new Set<string>();
    for (const rootId of [...new Set(sources.filter((s) => s.retained).map((s) => s.objectRootId))].sort()) {
      const root = validRoots.get(rootId); if (!root) continue;
      if (physicalStores.has(root.realPath)) { addBlock("inconsistent-evidence", rootId, "One physical object store must have one registry ID"); continue; }
      physicalStores.add(root.realPath);
      try {
        let files;
        try { files = await inventoryRetentionTree(root, "objects/sha256"); } catch (error) { if (isMissing(error)) files = []; else throw error; }
        const byId = new Map<string, typeof files[number]>();
        for (const file of files) {
          const match = /^([0-9a-f]{2})\/([0-9a-f]{62})\.zst$/u.exec(file.relativePath);
          if (match) byId.set(`sha256:${match[1]}${match[2]}`, file);
          else if (file.bytes > 0) addBlock("unknown-format", `${root.id}:${file.relativePath}`, "Unrecognized object-store entry");
        }
        // Reuse the existing collector's classification in dry-run mode, after a checked path inventory.
        const reachable = references.filter((ref) => ref.objectRootId === root.id && ref.targetKind === "content-object").map((ref) => ref.targetId);
        const gc = await new ZstdContentObjectStore(root.path).collect({ reachableObjectIds: reachable, dryRun: true });
        for (const item of gc.items) {
          const file = byId.get(item.objectId); if (!file || file.bytes !== item.bytes) throw new Error("Object inventory changed during preview");
          objects.push({ ...file, relativePath: `objects/sha256/${file.relativePath}`, rootId: root.id, objectId: item.objectId });
        }
        if (gc.items.length !== byId.size) throw new Error("Object inventory changed");
        for (const id of new Set(reachable)) if (!byId.has(id)) addBlock("missing-reference", `${root.id}:${id}`, "A retained body, handoff or evidence object is missing");
      } catch { addBlock("unsafe-path", root.id, "Object inventory could not be read consistently"); }
    }
    const resources = await captureRetentionResources(validRoots, registered, sources, activeRows, references, blockers);
    for (const root of validRoots.values()) if (["runs", "caches", "backups", "databases"].includes(root.purpose)) {
      try {
        for (const name of await readdir(root.path)) {
          if (name === ".retention-quarantine") continue;
          if (!registered.some((resource) => resource.rootId === root.id && resource.relativePath.split("/")[0] === name && resource.state !== "purged") && !sources.some((source) => source.rootId === root.id && source.relativePath.split("/")[0] === name)) addBlock("unregistered", `${root.id}:${name}`, "Undocumented resource remains protected until registered");
        }
      } catch { addBlock("unreadable", root.id, "Resource discovery failed"); }
    }
    references.sort((a, b) => retentionDigest(a).localeCompare(retentionDigest(b)));
    versions.sort((a, b) => `${a.source}:${a.id}`.localeCompare(`${b.source}:${b.id}`));
    objects.sort((a, b) => `${a.rootId}:${a.objectId}`.localeCompare(`${b.rootId}:${b.objectId}`));
    blockers.sort((a, b) => retentionDigest(a).localeCompare(retentionDigest(b)));
    return { schemaVersion: 1, asOf, roots, sources, sourceRevisions, versions, references, objects, resources, blockers,
      registryFingerprint: retentionDigest({ roots, sources, resources: registered }), referenceFingerprint: retentionDigest({ sourceRevisions, versions, references }), objectFingerprint: retentionDigest(objects), resourceFingerprint: retentionDigest(resources) };
  }

  private collectDatabaseReferences(source: RetentionSource, rows: RetentionRows, versions: RetentionVersion[], refs: RetentionReference[], block: (code: RetentionBlocker["code"], source: string, detail: string) => void): void {
    const all = (table: string): readonly Row[] => rows[table] ?? [];
    const ids = new Set(all("session_versions").map((row) => String(row.id)));
    const ref = (owner: string, targetKind: RetentionReference["targetKind"], target: unknown, reason: string): void => {
      const targetId = retentionString(target); if (!targetId) return;
      refs.push({ source: source.id, owner, targetKind, targetId, objectRootId: targetKind === "content-object" ? source.objectRootId : null, reason });
      if (targetKind.startsWith("version-") && !ids.has(targetId)) block("missing-reference", `${source.id}:${owner}`, `Missing referenced version ${targetId}`);
    };
    for (const row of all("session_versions")) {
      const id = String(row.id), snapshot = all("version_metadata_snapshots").find((entry) => entry.version_id === id);
      versions.push({ source: source.id, id, objectId: String(row.body_object), objectRootId: source.objectRootId, parents: all("version_parents").filter((entry) => entry.version_id === id).sort((a,b)=>Number(a.ordinal)-Number(b.ordinal)).map((entry)=>String(entry.parent_id)), firstPersistedAt: retentionString(snapshot?.first_persisted_at) });
      ref(id, "version-body", id, "all-version-bodies-retained; history-pruning-disabled");
      ref(id, "content-object", row.body_object, source.kind === "active-database" ? "retained-version-body" : "retained-external-database-body");
      if (!snapshot?.first_persisted_at) ref(id, "version-body", id, "local-first-persisted-time-unknown");
    }
    for (const row of all("version_parents")) ref(String(row.version_id), "version-metadata", row.parent_id, "version-graph-parent");
    for (const row of all("logical_sessions")) {
      ref(String(row.id), "version-body", row.head_version_id, "current-session-head");
      ref(String(row.id), "version-body", row.canonical_version_id, "canonical-session-head");
      if (row.head_version_id && row.canonical_version_id && row.head_version_id !== row.canonical_version_id) block("inconsistent-evidence", `${source.id}:${row.id}`, "Current head pointers disagree");
    }
    for (const row of all("workspace_memberships").filter((entry)=>entry.pinned === 1)) ref(String(row.logical_session_id), "version-body", all("logical_sessions").find((entry)=>entry.id === row.logical_session_id)?.head_version_id, "pinned-session-current-head");
    for (const [table, columns, reason] of [
      ["platform_bindings", ["last_common_version_id"], "platform-common-base"], ["platform_refs", ["version_id"], "platform-reference"],
      ["native_mirrors", ["common_version_id", "codex_version_id", "dsh_version_id"], "legacy-persisted-reference"],
      ["session_derivations", ["base_version_id"], "derivation-base"], ["projection_sessions", ["base_version_id"], "run-materialization-base"],
      ["run_operations", ["canonical_version_id"], "operation-receipt"],
    ] as const) for (const row of all(table)) for (const column of columns) ref(String(row.id ?? row.run_id ?? row.logical_session_id ?? row.child_session_id ?? row.operation_id), "version-body", row[column], reason);
    for (const row of all("checkpoints")) try {
      const entries = retentionRecord(retentionJson(row.refs_json));
      for (const [key, value] of Object.entries(entries)) {
        if (ids.has(String(value))) ref(String(row.id), "version-body", value, "checkpoint");
        else if (row.created_by === "projection-lifecycle" && key === "run" && all("projection_runs").some((entry)=>entry.id === value)) ref(String(row.id), "run", value, "projection-close-checkpoint-metadata");
        else if (!(row.created_by === "projection-lifecycle" && key === "catalog" && typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value))) block("unknown-format", `${source.id}:checkpoint:${row.id}`, `Unclassified checkpoint reference ${key}`);
      }
      const backups = retentionJson(row.backup_transaction_ids_json); if (!Array.isArray(backups)) throw new Error("Invalid checkpoint backups");
      for (const backup of backups) ref(String(row.id), "backup", backup, "checkpoint-backup");
    } catch { block("unknown-format", `${source.id}:checkpoint:${row.id}`, "Checkpoint references cannot be read"); }
    for (const row of all("session_tombstones")) ref(String(row.logical_session_id), "version-body", all("logical_sessions").find((entry)=>entry.id === row.logical_session_id)?.head_version_id, "tombstone-restore-head");
    for (const row of all("continuation_jobs")) try {
      ref(String(row.id), "content-object", row.handoff_object_id, "continuation-handoff");
      const sources = retentionJson(row.source_version_ids_json); if (!Array.isArray(sources)) throw new Error("Invalid continuation sources");
      for (const version of sources) ref(String(row.id), "version-body", version, "continuation-archive-source");
    } catch { block("unknown-format", `${source.id}:continuation:${row.id}`, "Continuation archive references cannot be read"); }
    for (const row of all("adapter_evidence")) ref(String(row.evidence_ref), "content-object", row.object_id, "adapter-evidence-preserved");
    for (const row of all("transactions")) if (!["completed", "restored"].includes(String(row.status))) ref(String(row.id), "backup", row.id, "transaction-recovery-required");
    for (const row of all("checkpoint_transactions")) ref(String(row.checkpoint_id), "backup", row.transaction_id, "checkpoint-backup");
    // Retained plans and work queues have no expiry contract. Capture all typed version fields, fail closed on malformed JSON.
    const visit = (value: unknown, owner: string): void => {
      if (Array.isArray(value)) { for (const item of value) visit(item, owner); return; }
      if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
        if (/^(?:versionId|baseVersionId|sourceVersionId|targetVersionId|commonVersionId|canonicalVersionId)$/u.test(key)) ref(owner, "version-body", child, "retained-plan-or-recovery-work");
        else visit(child, owner);
      }
    };
    for (const [table, column] of [["sync_plans","plan_json"],["jobs","request_json"],["transaction_steps","data_json"],["continuation_jobs","request_json"]] as const) for (const row of all(table)) try { visit(retentionJson(row[column]), `${table}:${row.id ?? row.transaction_id}`); } catch { block("unknown-format", `${source.id}:${table}`, "Retained recovery work is not readable"); }
  }
}
