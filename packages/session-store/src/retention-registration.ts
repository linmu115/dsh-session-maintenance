import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupManifestSchema, persistentProjectionCacheManifestV1Schema, SessionMaintenanceError, type RetentionDiscoveryResult, type RetentionResource } from "@linmu/dsh-session-contracts";
import { RetentionRepository, retentionRecord } from "./retention-repository.js";
import { checkedRetentionPath, inventoryRetentionTree, readRetentionJson, retentionDigest } from "./retention-paths.js";
import { ZstdContentObjectStore } from "./object-store.js";

async function fileDigest(path: string): Promise<string> {
  const hash=createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return `sha256:${hash.digest("hex")}`;
}

/** Explicit verification reads backup contents, never rewrites them. Preview itself only reads metadata. */
export async function verifyRetentionResource(repository: RetentionRepository, resourceId: string, at: string): Promise<RetentionResource> {
  const resource=repository.resources().find((entry)=>entry.id === resourceId);
  const root=repository.roots().find((entry)=>entry.id === resource?.rootId);
  if (!resource || !root || resource.state !== "registered") throw new SessionMaintenanceError("RECOVERY_REQUIRED","Resource is not registered for verification");
  const before=await inventoryRetentionTree(root,resource.relativePath);
  if (resource.kind === "backup") {
    const manifest=backupManifestSchema.parse(await readRetentionJson(root,`${resource.relativePath}/backup-manifest.json`));
    const {hash,...payload}=manifest;
    if (manifest.transactionId !== resource.ownerId || retentionDigest(payload) !== hash) throw new SessionMaintenanceError("BACKUP_CORRUPT","Backup manifest identity or digest mismatch");
    const row=repository.database.prepare("SELECT manifest_json,manifest_hash FROM backup_manifests WHERE transaction_id=?").get(resource.ownerId);
    if (!row || row.manifest_hash !== hash || retentionDigest(JSON.parse(String(row.manifest_json))) !== retentionDigest(manifest)) throw new SessionMaintenanceError("BACKUP_CORRUPT","Backup manifest disagrees with the transaction receipt");
    for (const entry of manifest.entries) {
      const hex=entry.objectId.slice(7), relative=`backups/sha256/${hex.slice(0,2)}/${hex.slice(2)}`;
      const file=before.find((candidate)=>candidate.relativePath === relative);
      if (!file && !entry.required) continue;
      if (!file || file.bytes !== entry.size || await fileDigest(await checkedRetentionPath(root,`${resource.relativePath}/${relative}`)) !== `sha256:${entry.sha256}`) throw new SessionMaintenanceError("BACKUP_CORRUPT","Backup content failed restoration verification");
    }
  } else if (resource.kind === "candidate") {
    const source=repository.sources().find((entry)=>entry.id === resource.ownerId && entry.retained && entry.kind !== "active-database" && entry.kind !== "unknown");
    if (!source || source.rootId !== root.id || !source.relativePath.startsWith(`${resource.relativePath}/`)) throw new SessionMaintenanceError("BACKUP_INCOMPLETE","Candidate directory must contain its registered database");
    const path=await checkedRetentionPath(root,source.relativePath);
    const manifest=retentionRecord(await readRetentionJson(root,`${source.relativePath}.manifest.json`));
    if (manifest.schemaVersion !== 1 || manifest.candidatePath !== path || manifest.candidateDigest !== await fileDigest(path)) throw new SessionMaintenanceError("BACKUP_CORRUPT","Candidate manifest does not verify the registered snapshot");
    const objectRoot=repository.roots().find((entry)=>entry.id === source.objectRootId); if (!objectRoot) throw new Error("Unregistered object store");
    await checkedRetentionPath(objectRoot);
    const database=new DatabaseSync(path,{readOnly:true});
    try {
      const schema=Number(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version);
      if (![16,17,19,20].includes(schema) || database.prepare("PRAGMA quick_check").all().some((row)=>Object.values(row)[0] !== "ok") || database.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Unsupported or invalid candidate database");
      const ids=new Set<string>();
      for (const [table,column] of [["session_versions","body_object"],["adapter_evidence","object_id"],["continuation_jobs","handoff_object_id"]] as const) for (const row of database.prepare(`SELECT ${column} AS id FROM ${table}`).all()) ids.add(String(row.id));
      const store=new ZstdContentObjectStore(objectRoot.path);
      for (const id of ids) {
        if (!/^sha256:[0-9a-f]{64}$/u.test(id)) throw new Error("Invalid candidate object reference");
        const hex=id.slice(7); await checkedRetentionPath(objectRoot,`objects/sha256/${hex.slice(0,2)}/${hex.slice(2)}.zst`); await store.get(id);
      }
    } finally { database.close(); }
  } else {
    const capture=await repository.capture(at), observed=capture.resources.find((entry)=>entry.resource.id === resource.id);
    if (!observed?.valid) throw new SessionMaintenanceError("VERIFICATION_FAILED","Run or cache identity and recovery evidence are incomplete");
  }
  const after=await inventoryRetentionTree(root,resource.relativePath);
  if (retentionDigest(before) !== retentionDigest(after)) throw new SessionMaintenanceError("PLAN_STALE","Resource changed during verification");
  const verified: RetentionResource={...resource,verifiedAt:at,verifiedFingerprint:retentionDigest(after)};
  repository.registerResource(verified); return verified;
}

/** Discover only known producer evidence beneath explicitly registered roots. Unknown entries are reported. */
export async function discoverRetentionResources(repository: RetentionRepository, at: string): Promise<RetentionDiscoveryResult> {
  const registeredResourceIds: string[]=[],unknownPaths:string[]=[];
  const existing=repository.resources();
  for (const root of repository.roots()) {
    if (!["runs","caches","backups"].includes(root.purpose)) continue;
    await checkedRetentionPath(root);
    const candidates:string[]=[];
    if (root.purpose === "caches") {
      for (const file of await inventoryRetentionTree(root)) if (file.relativePath.endsWith("/projection-cache-manifest.json") && !file.relativePath.startsWith(".retention-quarantine/")) candidates.push(file.relativePath.slice(0,-"/projection-cache-manifest.json".length));
    } else candidates.push(...(await readdir(root.path)).filter((name)=>name !== ".retention-quarantine"));
    for (const path of candidates) {
      if (existing.some((entry)=>entry.rootId === root.id && entry.relativePath === path && entry.state !== "purged")) continue;
      try {
        let kind:RetentionResource["kind"],ownerId:string;
        if (root.purpose === "runs") {
          const descriptor=retentionRecord(await readRetentionJson(root,`${path}/recovery.json`));
          if (descriptor.schemaVersion !== 1 || typeof descriptor.runId !== "string" || !repository.database.prepare("SELECT id FROM projection_runs WHERE id=?").get(descriptor.runId)) throw new Error("Unknown run");
          kind="run"; ownerId=descriptor.runId;
        } else if (root.purpose === "caches") {
          const manifest=persistentProjectionCacheManifestV1Schema.parse(await readRetentionJson(root,`${path}/projection-cache-manifest.json`)); kind="cache";ownerId=manifest.cacheKey;
        } else {
          const manifest=backupManifestSchema.parse(await readRetentionJson(root,`${path}/backup-manifest.json`));
          if (!repository.database.prepare("SELECT transaction_id FROM backup_manifests WHERE transaction_id=? AND manifest_hash=?").get(manifest.transactionId,manifest.hash)) throw new Error("Unknown backup");
          kind="backup";ownerId=manifest.transactionId;
        }
        const id=`resource_${retentionDigest({root:root.id,path,ownerId}).slice(7,31)}`;
        repository.registerResource({id,rootId:root.id,relativePath:path,kind,ownerId,group:kind === "backup" ? "transaction-backups" : root.id,pinned:false,recoveryRequired:false,verifiedAt:null,verifiedFingerprint:null,lastUsedAt:kind === "cache" ? at : null,state:"registered"});
        registeredResourceIds.push(id);
      } catch { unknownPaths.push(`${root.id}:${path}`); }
    }
  }
  return {registeredResourceIds:registeredResourceIds.sort(),unknownPaths:unknownPaths.sort()};
}
