import { readFile, writeFile, symlink, mkdir, utimes, rename } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { assertRetentionPlanCurrent, DEFAULT_RETENTION_POLICY, inventoryRetentionTree, planRetention, retentionDigest } from "../src/index.js";
import { NOW, retentionFixture } from "./retention-fixture.js";

const fixtures: Awaited<ReturnType<typeof retentionFixture>>[] = [];
async function fixture() { const f = await retentionFixture(); fixtures.push(f); return f; }
afterEach(async()=>{ for (const f of fixtures.splice(0)) await f.close(); });

describe("SM-08 reference-safe read-only planning",()=>{
  it("protects every old body, preserves graph-only parent reasons and de-duplicates shared objects across retained databases",async()=>{
    const f = await fixture();
    const shared = await f.addVersion("v1","shared"); await f.addVersion("v2","shared","v1");
    f.database.prepare("INSERT INTO checkpoints VALUES ('manual','manual','','{\"session:session\":\"v1\"}','[]','user',?)").run(NOW);
    await f.external("archive");
    const before = await f.repository.capture(NOW), plan = planRetention(before);
    expect(plan.blockers).toEqual([]);
    expect(before.versions).toHaveLength(4);
    expect(before.references).toEqual(expect.arrayContaining([
      expect.objectContaining({targetId:"v1",targetKind:"version-metadata",reason:"version-graph-parent"}),
      expect.objectContaining({targetId:"v1",targetKind:"version-body",reason:"checkpoint"}),
      expect.objectContaining({targetId:shared,source:"archive",reason:"retained-external-database-body"}),
    ]));
    const items = plan.items.filter((item)=>item.kind === "content-object");
    expect(items).toHaveLength(1); expect(items[0]?.disposition).toBe("protected");
    expect(plan.protectedBytes).toBeGreaterThan(items[0]!.bytes); expect(plan.items.filter((item)=>item.kind === "database")).toHaveLength(1); expect(plan.candidateBytes).toBe(0);
    expect(before.versions.every((version)=>version.firstPersistedAt !== "1900-01-01T00:00:00.000Z")).toBe(true);
    expect(planRetention(await f.repository.capture(NOW))).toEqual(plan);
  });

  it("reuses GC for orphan preview without deleting, and a new checkpoint/evidence/source makes the fixed plan stale",async()=>{
    const f = await fixture(); await f.addVersion("head");
    const orphan = await f.objects.put(Buffer.from("orphan")), hex=orphan.slice(7), path=join(f.root,"objects","sha256",hex.slice(0,2),`${hex.slice(2)}.zst`);
    await utimes(path,new Date("2020-01-01"),new Date("2020-01-01"));
    const before = await readFile(path), inventory=await f.repository.capture(NOW), plan=planRetention(inventory);
    expect(plan.items.find((item)=>item.id.endsWith(orphan))).toMatchObject({disposition:"candidate",executable:false});
    expect(plan.executableBytes).toBe(0); expect(await readFile(path)).toEqual(before);
    f.database.prepare("INSERT INTO checkpoints VALUES ('pin','pin','','{\"session:session\":\"head\"}','[]','user',?)").run(NOW);
    expect(()=>assertRetentionPlanCurrent(plan, {...inventory, referenceFingerprint:"changed"})).toThrow();
    expect(()=>assertRetentionPlanCurrent(plan, inventory)).not.toThrow();
    expect(()=>assertRetentionPlanCurrent(plan, {...inventory, asOf:"2026-09-07T12:00:00.000Z"})).toThrow();
    const changed=await f.repository.capture(NOW); expect(()=>assertRetentionPlanCurrent(plan,changed)).toThrowError(expect.objectContaining({code:"PLAN_STALE"}));
  });

  it("blocks unregistered, corrupt, unknown-schema, and missing retained databases instead of counting zero refs",async()=>{
    const f=await fixture(); await f.addVersion("head");
    await writeFile(join(f.root,"unknown-candidate.sqlite"),"not a database");
    expect((await f.repository.capture(NOW)).blockers).toEqual(expect.arrayContaining([expect.objectContaining({code:"unregistered"})]));
    f.repository.registerSource({id:"unknown",rootId:"state",relativePath:"unknown-candidate.sqlite",objectRootId:"state",kind:"candidate-database",retained:true});
    expect((await f.repository.capture(NOW)).blockers).toEqual(expect.arrayContaining([expect.objectContaining({source:"unknown",code:"unreadable"})]));
    const archive=await f.external("future");
    const db=new DatabaseSync(archive); db.prepare("INSERT INTO schema_migrations VALUES (999,?)").run(NOW); db.close();
    expect((await f.repository.capture(NOW)).blockers).toEqual(expect.arrayContaining([expect.objectContaining({source:"future",code:"unknown-format"})]));
    f.repository.registerSource({id:"missing",rootId:"state",relativePath:"missing.sqlite",objectRootId:"state",kind:"backup-database",retained:true});
    expect(planRetention(await f.repository.capture(NOW)).items.every((item)=>!item.executable)).toBe(true);
  });

  it("retains handoff/evidence/continuation/derivation/tombstone dependencies and flags ambiguous checkpoints",async()=>{
    const f=await fixture(); const body=await f.addVersion("base");
    const evidence=await f.objects.put(Buffer.from("native evidence")), handoff=await f.objects.put(Buffer.from("handoff"));
    f.database.prepare("INSERT INTO adapter_evidence VALUES ('ev','adapter','format','fixture',?,?,?,?)").run(evidence,15,NOW,NOW);
    f.database.prepare("INSERT INTO continuation_jobs(id,request_hash,request_json,logical_session_id,source_version_ids_json,target_preset_id,mode,handoff_object_id,status,created_at,updated_at) VALUES ('job','hash','{}','session','[\"base\"]','p','full',?,'manual-review',?,?)").run(handoff,NOW,NOW);
    f.database.prepare("INSERT INTO logical_sessions(id,display_title,sync_mode,archived,labels_json,created_at,authority_scope,origin_kind) VALUES ('child','child','continuation',0,'[]',?,'maintenance','codex-derived')").run(NOW);
    f.database.prepare("INSERT INTO session_derivations VALUES ('child','session','base','dsh-continuation','run','operation',?)").run(NOW);
    f.database.prepare("INSERT INTO checkpoints VALUES ('delete','delete','','{\"session:session\":\"base\"}','[]','maintenance-dashboard',?)").run(NOW);
    f.database.prepare("INSERT INTO session_tombstones VALUES ('session','delete-op','delete',NULL,?,'2027-01-01T00:00:00.000Z',NULL)").run(NOW);
    const inventory=await f.repository.capture(NOW);
    expect(inventory.blockers).toEqual([]);
    expect(inventory.references).toEqual(expect.arrayContaining([
      expect.objectContaining({targetId:body,reason:"retained-version-body"}),expect.objectContaining({targetId:evidence,reason:"adapter-evidence-preserved"}),expect.objectContaining({targetId:handoff,reason:"continuation-handoff"}),expect.objectContaining({targetId:"base",reason:"derivation-base"}),expect.objectContaining({targetId:"base",reason:"tombstone-restore-head"}),expect.objectContaining({targetId:"base",reason:"continuation-archive-source"}),
    ]));
    f.database.prepare("INSERT INTO checkpoints VALUES ('unknown','unknown','','{\"other\":\"unresolved\"}','[]','user',?)").run(NOW);
    expect((await f.repository.capture(NOW)).blockers).toEqual(expect.arrayContaining([expect.objectContaining({code:"unknown-format",source:"active:checkpoint:unknown"})]));
  });

  it("rejects junction traversal, root replacement, hard links, and unknown resource entries",async()=>{
    const f=await fixture(); const resource=await f.resource("cache","c");
    await mkdir(join(f.root,"outside"));
    await symlink(join(f.root,"outside"),join(resource.path,"escape"),"junction");
    await expect(inventoryRetentionTree(resource.root,"c")).rejects.toThrow();
    expect((await f.repository.capture(NOW)).blockers.length).toBeGreaterThan(0);
    await rename(resource.root.path,`${resource.root.path}-old`); await mkdir(resource.root.path);
    expect((await f.repository.capture(NOW)).blockers).toEqual(expect.arrayContaining([expect.objectContaining({source:"cache",code:"unsafe-path"})]));
    expect(()=>f.repository.registerSource({id:"escape",rootId:"state",relativePath:"../outside.sqlite",objectRootId:"state",kind:"backup-database",retained:true})).toThrow();
  });

  it("uses strict policy floors and has no five-day history deletion mode",async()=>{
    const f=await fixture(); const inventory=await f.repository.capture(NOW);
    expect(()=>planRetention(inventory,{...DEFAULT_RETENTION_POLICY,quarantineHours:0})).toThrow();
    expect(()=>planRetention(inventory,{...DEFAULT_RETENTION_POLICY,history:"five-days" as never})).toThrow();
    const plan=planRetention(inventory); expect(plan.id).toBe(retentionDigest(Object.fromEntries(Object.entries(plan).filter(([key])=>key!=="id"))));
  });

  it("reads schema-16 rollback references with explicitly unknown local clocks and rebinds a copied active selection",async()=>{
    const f=await fixture();const body=await f.addVersion("old");const path=await f.external("rollback16");
    const old=new DatabaseSync(path);
    old.exec("DROP TRIGGER session_version_metadata_created; DROP TRIGGER version_metadata_immutable; DROP TABLE version_metadata_snapshots; DELETE FROM schema_migrations WHERE version>=17");old.close();
    const inventory=await f.repository.capture(NOW);expect(inventory.blockers).toEqual([]);
    expect(inventory.versions.find((version)=>version.source === "rollback16")).toMatchObject({objectId:body,firstPersistedAt:null});
    const active=f.repository.sources().find((source)=>source.kind === "active-database")!;
    f.database.prepare("UPDATE retention_sources SET source_json=? WHERE id=?").run(JSON.stringify({...active,relativePath:"rollback16.sqlite"}),active.id);
    await f.repository.bindActiveSource("state","metadata.sqlite","state");
    expect(f.repository.sources().filter((source)=>source.kind === "active-database")).toHaveLength(1);
    expect(f.repository.sources().find((source)=>source.id === active.id)).toMatchObject({kind:"backup-database",retained:true,relativePath:"rollback16.sqlite"});
    expect((await f.repository.capture(NOW)).blockers).toEqual([]);
  });

  it("plans thousands of independent version references with indexed object lookups",async()=>{
    const f=await fixture(),inventory=await f.repository.capture(NOW),count=5000;
    const versions=Array.from({length:count},(_,i)=>({source:"active",id:`v${i}`,objectId:`sha256:${i.toString(16).padStart(64,"0")}`,objectRootId:"state",parents:[],firstPersistedAt:null}));
    const objects=versions.map((version)=>({rootId:"state",objectId:version.objectId,relativePath:`objects/${version.id}`,identity:version.id,bytes:17,mtimeMs:0}));
    const references=versions.flatMap((version)=>[{source:"active",owner:version.id,targetKind:"content-object" as const,targetId:version.objectId,objectRootId:"state",reason:"retained-version-body"},{source:"active",owner:version.id,targetKind:"version-body" as const,targetId:version.id,objectRootId:null,reason:"current-head"}]);
    const plan=planRetention({...inventory,versions,objects,references});expect(plan.protectedBytes).toBe(count*17);expect(plan.items).toHaveLength(count);expect(plan.items.every((item)=>item.references.length === 2)).toBe(true);
  },10000);
});
