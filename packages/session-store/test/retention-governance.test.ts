import { mkdir, readFile, writeFile, access, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RetentionExecutor, DEFAULT_RETENTION_POLICY, discoverRetentionResources, inventoryRetentionTree, planRetention, retentionDigest, verifyRetentionResource } from "../src/index.js";
import { MaintenanceWriteCoordinator } from "../src/write-coordinator.js";
import { TransactionBackupStore } from "../../transaction-engine/src/backup-store.js";
import { RetentionService } from "../../../apps/engine/src/retention-service.js";
import { NOW, retentionFixture } from "./retention-fixture.js";

const cleanup:(()=>Promise<void>)[]=[];
const OLD="2026-09-01T00:00:00.000Z", LATER="2026-09-09T12:00:00.000Z";
async function fixture() {
  const f=await retentionFixture(),writes=MaintenanceWriteCoordinator.acquire(f.root,"engine");
  let now=NOW;
  cleanup.push(async()=>{await writes.close();await f.close();});
  const executor=(fault?:ConstructorParameters<typeof RetentionExecutor>[0]["fault"])=>new RetentionExecutor({repository:f.repository,writes,now:()=>now,executionEnabled:true,...(fault ? {fault}: {})});
  const cache=async(id:string,used=OLD)=>{
    const resource=await f.resource("cache",id);
    await writeFile(join(resource.path,"projection-cache-manifest.json"),JSON.stringify({schemaVersion:1,cacheKey:id,adapterId:"adapter",adapterFingerprint:"digest",configurationDigest:"configuration",lastAppliedRevision:0,sessions:[],workspaces:[],createdAt:OLD,updatedAt:OLD}));
    await writeFile(join(resource.path,"payload.json"),JSON.stringify({synthetic:id}));
    f.repository.registerResource({...resource.entry,lastUsedAt:used});return resource;
  };
  const run=async(id:string,state="closed",base?:string)=>{
    const resource=await f.resource("run",id);
    f.database.prepare("INSERT OR IGNORE INTO adapter_registrations VALUES ('adapter','{}','synthetic',1,?,?)").run(NOW,NOW);
    f.database.prepare("INSERT INTO checkpoints VALUES (?,?, '',?, '[]','projection-lifecycle',?)").run(`close-${id}`,id,JSON.stringify({run:id,catalog:`sha256:${"a".repeat(64)}`}),OLD);
    f.database.prepare("INSERT INTO projection_runs VALUES (?,?,?,?,?,'fixture','adapter',?,?,?,?)").run(id,`lease-${id}`,`branch-${id}`,"instance","profile",state,OLD,OLD,`close-${id}`);
    await mkdir(join(resource.path,"projection"));
    await writeFile(join(resource.path,"projection","native.json"),JSON.stringify({synthetic:id}));
    await writeFile(join(resource.path,"recovery.json"),JSON.stringify({schemaVersion:1,runId:id,maintenanceEndpoint:"http://127.0.0.1:1",...(base ? {baseProjectionRoot:base}: {})}));
    return resource;
  };
  const preview=async()=>planRetention(await f.repository.capture(now),{...DEFAULT_RETENTION_POLICY,cacheTargetBytes:0});
  return {...f,writes,executor,cache,run,preview,setNow:(value:string)=>{now=value;},clock:()=>now};
}
afterEach(async()=>{for(const close of cleanup.splice(0).reverse()) await close();});

describe("SM-09 explicit directory governance",()=>{
  it("keeps active, unresolved, pending-WAL runs and retained sparse cache bases; releases only verified finished runs",async()=>{
    const f=await fixture();const c=await f.cache("base"),closed=await f.run("closed","closed",c.path);await f.run("active","running");await f.run("quarantine","quarantined");
    const pending=await f.run("pending");await mkdir(join(pending.path,"wal"));await writeFile(join(pending.path,"wal","pending.json"),JSON.stringify({schemaVersion:1,operation:{operationId:"pending",runId:"pending"},state:"pending",projectionApplied:false,receipt:null}));
    const plan=await f.preview(); expect(plan.blockers).toEqual([]);
    expect(plan.items.find((item)=>item.id === closed.entry.id)).toMatchObject({disposition:"candidate",executable:true});
    for (const id of ["base","active","quarantine","pending"]) expect(plan.items.find((item)=>item.id === id)?.disposition).toBe("protected");
    expect(plan.cacheBytesAboveTarget).toBeGreaterThan(0);
    const batch=await f.executor().quarantine(plan);expect(batch.items).toHaveLength(1);expect(batch.items[0]?.state).toBe("quarantined");
    expect((await f.preview()).items.find((item)=>item.id === "base")?.disposition).toBe("protected");
  });

  it("quarantines, restores byte-for-byte, refuses early purge, and is idempotent across repeated requests",async()=>{
    const f=await fixture(),cache=await f.cache("c"),before=retentionDigest(await inventoryRetentionTree(cache.root,"c")),plan=await f.preview();
    const executor=f.executor(),batch=await executor.quarantine(plan);
    await expect(access(cache.path)).rejects.toThrow();expect((await executor.quarantine(plan)).id).toBe(batch.id);
    await expect(executor.purge(batch.id)).rejects.toMatchObject({code:"CONFIRMATION_REQUIRED"});
    const restored=await executor.restore(batch.id);expect(restored.items[0]?.state).toBe("restored");
    expect(retentionDigest(await inventoryRetentionTree(cache.root,"c"))).toBe(before);
    expect(await executor.restore(batch.id)).toEqual(restored);
  });

  it("reconciles crashes after quarantine and restore moves using recorded identities without overwriting destinations",async()=>{
    const f=await fixture(),c=await f.cache("c"),plan=await f.preview();let crash=true;
    const broken=f.executor((stage)=>{if(stage === "after-quarantine-move" && crash){crash=false;throw new Error("synthetic crash");}});
    await expect(broken.quarantine(plan)).rejects.toMatchObject({code:"RECOVERY_REQUIRED"});
    expect(broken.journal.list()[0]?.items[0]?.state).toBe("planned");
    const batch=await f.executor().quarantine(plan);expect(batch.items[0]?.state).toBe("quarantined");
    const restoreCrash=f.executor((stage)=>{if(stage === "after-restore-move")throw new Error("synthetic crash");});
    await expect(restoreCrash.restore(batch.id)).rejects.toMatchObject({code:"RECOVERY_REQUIRED"});
    const restored=await f.executor().restore(batch.id);expect(restored.items[0]?.state).toBe("restored");expect(await readFile(join(c.path,"payload.json"),"utf8")).toContain("synthetic");
  });

  it("revalidates new protection before quarantine and before final release",async()=>{
    const f=await fixture(),c=await f.cache("c"),plan=await f.preview();
    f.repository.registerResource({...f.repository.resources().find((resource)=>resource.id === c.entry.id)!,pinned:true});
    await expect(f.executor().quarantine(plan)).rejects.toMatchObject({code:"PLAN_STALE"});
    f.repository.registerResource({...f.repository.resources().find((resource)=>resource.id === c.entry.id)!,pinned:false});
    const batch=await f.executor().quarantine(await f.preview());f.setNow(LATER);
    const current=f.repository.resources().find((entry)=>entry.id === "c")!;
    f.database.prepare("UPDATE retention_resources SET resource_json=? WHERE id='c'").run(JSON.stringify({...current,pinned:true}));
    await expect(f.executor().purge(batch.id)).rejects.toMatchObject({code:"PLAN_STALE"});
    expect((await f.executor().restore(batch.id)).items[0]?.state).toBe("restored");
  });

  it("resumes partial final release idempotently and never collects canonical version bodies",async()=>{
    const f=await fixture(),body=await f.addVersion("old");await f.cache("c");
    const batch=await f.executor().quarantine(await f.preview());f.setNow(LATER);let once=true;
    const interrupted=f.executor((stage)=>{if(stage === "after-unlink" && once){once=false;throw new Error("synthetic interruption");}});
    await expect(interrupted.purge(batch.id)).rejects.toMatchObject({code:"RECOVERY_REQUIRED"});expect(interrupted.journal.get(batch.id)?.items[0]?.state).toBe("purging");
    const purged=await f.executor().purge(batch.id);expect(purged.items[0]?.state).toBe("purged");expect(await f.executor().purge(batch.id)).toEqual(purged);
    expect(Buffer.from(await f.objects.get(body)).toString()).toBe("old");
    await expect(f.executor().restore(batch.id)).rejects.toMatchObject({code:"TRANSACTION_NOT_RESTORABLE"});
  });

  it("refuses unknown file additions, reused destinations and junction swaps during recovery",async()=>{
    const f=await fixture(),c=await f.cache("c"),batch=await f.executor().quarantine(await f.preview());
    await mkdir(c.path);await writeFile(join(c.path,"new-owner.txt"),"new");
    await expect(f.executor().restore(batch.id)).rejects.toMatchObject({code:"PLAN_STALE"});
    await rename(c.path,join(f.root,"reused-destination"));
    const q=join(c.root.path,batch.items[0]!.quarantinePath);await rename(q,`${q}-preserved`);await symlink(join(f.root,"reused-destination"),q,"junction");
    await expect(f.executor().restore(batch.id)).rejects.toThrow();
    expect(await readFile(join(f.root,"reused-destination","new-owner.txt"),"utf8")).toBe("new");
  });

  it("keeps three valid backups per group, verifies restore bytes, and protects checkpoint/manual backup pins",async()=>{
    const f=await fixture();const backups=[];
    for(let i=0;i<5;i++) {
      const id=`txn-${i}`,r=await f.resource("backup",id),at=`2026-09-0${i+1}T00:00:00.000Z`;
      f.database.prepare("INSERT INTO sync_plans VALUES (?,?, '{}',?)").run(`plan-${i}`,`hash-${i}`,at);
      f.database.prepare("INSERT INTO transactions(id,plan_id,plan_hash,platform,instance_id,root_identity,adapter_contract_json,status,created_at,updated_at) VALUES (?,?,?,'dsh','fixture','fixture','{}','completed',?,?)").run(id,`plan-${i}`,`hash-${i}`,at,at);
      const store=new TransactionBackupStore(r.path),entry=await store.put("synthetic-dsh-snapshot",Buffer.from(`restore-${i}`),true),manifest=await store.finalize(id,[entry],at);
      f.database.prepare("INSERT INTO backup_manifests VALUES (?,?,?,?)").run(id,manifest.hash,JSON.stringify(manifest),at);
      await verifyRetentionResource(f.repository,id,NOW);backups.push({r,store,entry});
    }
    let plan=await f.preview();expect(plan.items.filter((item)=>item.kind === "backup" && item.disposition === "candidate")).toHaveLength(2);
    f.database.prepare("INSERT INTO checkpoints VALUES ('protect','manual','','{}','[\"txn-1\"]','user',?)").run(NOW);
    plan=await f.preview();expect(plan.items.filter((item)=>item.kind === "backup" && item.disposition === "candidate")).toHaveLength(1);
    const batch=await f.executor().quarantine(plan);expect(batch.items[0]?.resourceId).toBe("txn-0");
    for(const saved of backups.slice(1)) expect(Buffer.from(await saved.store.get(saved.entry)).toString()).toMatch(/^restore-/u);
    await f.executor().restore(batch.id);expect(Buffer.from(await backups[0]!.store.get(backups[0]!.entry)).toString()).toBe("restore-0");
  });

  it("uses the SM-05 exclusive boundary through the physical operation and rejects unenabled execution",async()=>{
    const f=await fixture();await f.cache("c");const plan=await f.preview();
    await expect(new RetentionExecutor({repository:f.repository,writes:f.writes}).quarantine(plan)).rejects.toMatchObject({code:"WRITE_CAPABILITY_UNAVAILABLE"});
    const order:string[]=[];let signal!:()=>void;const moved=new Promise<void>((resolve)=>{signal=resolve;});
    const executor=f.executor((stage)=>{if(stage === "after-quarantine-move") {f.writes.assertInScope();order.push("moved");signal();}});
    const queued=(async()=>{await moved;await f.writes.run("synthetic-new-writer",()=>{expect(executor.journal.list()[0]?.items[0]?.state).toBe("quarantined");order.push("writer");});})();
    await executor.quarantine(plan);await queued;expect(order).toEqual(["moved","writer"]);
    expect(executor.journal.list()[0]?.items[0]?.state).toBe("quarantined");
  });

  it("service discovery registers known resources conservatively, validates requests and exposes recoverable batches",async()=>{
    const f=await fixture(),c=await f.cache("cache");
    f.database.exec("DELETE FROM retention_resources");
    const service=new RetentionService({repository:f.repository,writes:f.writes,clock:f.clock,executionEnabled:true});
    const discovered=await service.discover();expect(discovered.registeredResourceIds).toHaveLength(1);
    expect(service.registry().resources).toHaveLength(1);expect(await service.verify(discovered.registeredResourceIds[0]!)).toMatchObject({verifiedAt:NOW});
    await mkdir(join(c.root.path,"unknown-cache"));
    expect((await service.preview({...DEFAULT_RETENTION_POLICY,cacheTargetBytes:0})).blockers.length).toBeGreaterThan(0);
    expect(()=>service.registerSource({id:"x",rootId:"state",objectRootId:"state",relativePath:"../bad",kind:"candidate-database",retained:true})).toThrow();
    await expect(service.execute("unknown-plan")).rejects.toMatchObject({code:"PLAN_STALE"});expect(service.listBatches()).toEqual([]);
  });
});
