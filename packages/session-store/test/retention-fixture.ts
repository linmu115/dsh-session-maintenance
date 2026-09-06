import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup } from "node:sqlite";
import { openMaintenanceDatabase, RetentionRepository, ZstdContentObjectStore, inventoryRetentionTree, retentionDigest } from "../src/index.js";
import type { RetentionResource } from "@linmu/dsh-session-contracts";

export const NOW = "2026-09-06T12:00:00.000Z";
export async function retentionFixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-sm-retention-SYNTHETIC-"));
  await writeFile(join(root, "SYNTHETIC-ONLY.txt"), "Synthetic retention test. No real homes.");
  const dbPath = join(root, "metadata.sqlite"), database = openMaintenanceDatabase(dbPath);
  const repository = new RetentionRepository(database, dbPath), objects = new ZstdContentObjectStore(root);
  await repository.registerRoot("state", root, "state");
  repository.registerSource({ id: "active", rootId: "state", relativePath: "metadata.sqlite", objectRootId: "state", kind: "active-database", retained: true });
  const addVersion = async (id: string, body = id, parent?: string) => {
    database.prepare("INSERT OR IGNORE INTO logical_sessions(id,display_title,sync_mode,archived,labels_json,created_at,authority_scope,origin_kind) VALUES (?,'synthetic','continuation',0,'[]',?,'maintenance','maintenance-native')").run("session", NOW);
    const objectId = await objects.put(Buffer.from(body));
    database.prepare("INSERT INTO session_versions(id,logical_session_id,body_object,body_hash,metadata_hash,manifest_json,created_at) VALUES (?,'session',?,?,?,'{}','1900-01-01T00:00:00.000Z')").run(id,objectId,objectId,"sha256:" + "0".repeat(64));
    if (parent) database.prepare("INSERT INTO version_parents VALUES (?,0,?)").run(id,parent);
    database.prepare("UPDATE logical_sessions SET head_version_id=?,canonical_version_id=? WHERE id='session'").run(id,id);
    return objectId;
  };
  const external = async (id: string) => {
    const path = join(root, `${id}.sqlite`); await backup(database, path);
    repository.registerSource({ id, rootId:"state",relativePath:`${id}.sqlite`,objectRootId:"state",kind:"backup-database",retained:true });
    return path;
  };
  const resource = async (kind: RetentionResource["kind"], id: string) => {
    const parent = join(root, `${kind}-resources`); await mkdir(parent,{recursive:true});
    const registeredRoot = await repository.registerRoot(kind,parent,kind === "run" ? "runs" : kind === "cache" ? "caches" : "backups");
    const path = join(parent,id); await mkdir(path,{recursive:true});
    const entry: RetentionResource = { id,rootId:kind,relativePath:id,kind,ownerId:id,group:"default",pinned:false,recoveryRequired:false,verifiedAt:null,verifiedFingerprint:null,lastUsedAt:null,state:"registered" };
    repository.registerResource(entry);
    return { entry,path,root:registeredRoot, verify:async () => {
      const verified = { ...entry,verifiedAt:NOW,verifiedFingerprint:retentionDigest(await inventoryRetentionTree(registeredRoot,id)) };
      repository.registerResource(verified); return verified;
    } };
  };
  return { root,database,repository,objects,addVersion,external,resource,close:async()=>{ database.close(); await rm(root,{recursive:true,force:true}); } };
}
