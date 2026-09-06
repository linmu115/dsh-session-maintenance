import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { openMaintenanceDatabase } from "../src/index.js";

it("SM-08 migration failure rolls back registry and registration, and retry is idempotent",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dsh-sm-retention-migration-SYNTHETIC-")), path=join(root,"metadata.sqlite");
  try {
    let db=openMaintenanceDatabase(path);
    db.exec("DROP TABLE codex_project_mapping_removals; DROP TABLE codex_project_mapping_policy; DROP TABLE retention_batches; DROP TABLE retention_resources; DROP TABLE retention_sources; DROP TABLE retention_roots; DELETE FROM schema_migrations WHERE version >= 19; CREATE TABLE retention_sources(synthetic_conflict TEXT)"); db.close();
    expect(()=>openMaintenanceDatabase(path)).toThrow();
    db=new DatabaseSync(path);
    expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({version:17});
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='retention_roots'").get()).toBeUndefined();
    db.exec("DROP TABLE retention_sources"); db.close();
    db=openMaintenanceDatabase(path); expect(db.prepare("SELECT COUNT(*) AS count FROM retention_sources").get()).toEqual({count:0}); db.close();
    db=openMaintenanceDatabase(path); expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=19").get()).toEqual({count:1}); db.close();
  } finally { await rm(root,{recursive:true,force:true}); }
});

it("SM-09 journal migration preserves existing registry on failure and can retry",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dsh-sm-retention-journal-SYNTHETIC-")),path=join(root,"metadata.sqlite");
  try {
    let db=openMaintenanceDatabase(path);db.exec("DROP TABLE codex_project_mapping_removals; DROP TABLE codex_project_mapping_policy; DELETE FROM schema_migrations WHERE version>=20; DROP TABLE retention_batches; CREATE TABLE retention_batches(synthetic_conflict TEXT)");db.close();
    expect(()=>openMaintenanceDatabase(path)).toThrow();db=new DatabaseSync(path);
    expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({version:19});expect(db.prepare("SELECT COUNT(*) AS count FROM retention_roots").get()).toEqual({count:0});
    db.exec("DROP TABLE retention_batches");db.close();db=openMaintenanceDatabase(path);expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=20").get()).toEqual({count:1});db.close();
  } finally {await rm(root,{recursive:true,force:true});}
});
