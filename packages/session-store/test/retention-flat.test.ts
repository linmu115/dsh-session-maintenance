import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { RetentionExecutor, RetentionRepository, planRetention, registerFlatRetentionCandidate, retentionDigest } from "../src/index.js";
import { MaintenanceWriteCoordinator } from "../src/write-coordinator.js";
import { RetentionService } from "../../../apps/engine/src/retention-service.js";
import { NOW, retentionFixture } from "./retention-fixture.js";

const cleanup:(()=>Promise<void>)[]=[];
async function fixture() {
  const f=await retentionFixture(),writes=MaintenanceWriteCoordinator.acquire(f.root,"engine");let now=NOW;
  cleanup.push(async()=>{await writes.close();await f.close();});
  const executor=(fault?:ConstructorParameters<typeof RetentionExecutor>[0]["fault"])=>new RetentionExecutor({repository:f.repository,writes,now:()=>now,executionEnabled:true,...(fault ? {fault}: {})});
  const candidate=async(id:string)=>{
    const path=await f.external(id),bytes=await readFile(path);
    await writeFile(`${path}.manifest.json`,JSON.stringify({schemaVersion:1,candidatePath:path,candidateDigest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`,createdAt:NOW}));
    return {id,path,bytes};
  };
  const prepare=async()=>{
    const body=await f.addVersion("head","shared old body"),candidates=[];
    for(let i=0;i<4;i++) {const c=await candidate(`candidate-${i}`);now=new Date(Date.parse(NOW)+i*1000).toISOString();const resource=await writes.run("synthetic-register-flat",()=>registerFlatRetentionCandidate(f.repository,c.id,now));candidates.push({...c,resource});}
    const plan=planRetention(await f.repository.capture(now));expect(plan.blockers).toEqual([]);
    expect(plan.items.filter((item)=>item.executable)).toHaveLength(1);
    return {body,candidates,plan};
  };
  return {...f,writes,executor,candidate,prepare,clock:()=>now,later:()=>{now="2026-09-10T00:00:00.000Z";}};
}
afterEach(async()=>{for(const close of cleanup.splice(0).reverse()) await close();});

describe("SM-09 static flat SQLite recovery points",()=>{
  it("accounts for database and manifest exactly once and restores the complete original file set",async()=>{
    const f=await fixture(),{body,candidates,plan}=await f.prepare(),c=candidates[0]!;
    const planned=plan.items.find((item)=>item.id === c.resource.id)!;
    expect(planned.bytes).toBe(c.bytes.byteLength+(await readFile(`${c.path}.manifest.json`)).byteLength);
    expect(plan.items.filter((item)=>item.kind === "database")).toEqual([]);
    const manifest=await readFile(`${c.path}.manifest.json`),batch=await f.executor().quarantine(plan);
    expect(batch.items[0]?.moves?.map((move)=>move.state)).toEqual(["quarantined","quarantined"]);
    await expect(access(c.path)).rejects.toThrow();await expect(access(`${c.path}.manifest.json`)).rejects.toThrow();
    const isolated=await f.repository.capture(f.clock());expect(isolated.blockers).toEqual([]);
    expect(isolated.references).toEqual(expect.arrayContaining([expect.objectContaining({source:c.id,targetId:body,reason:"retained-external-database-body"})]));
    const restored=await f.executor().restore(batch.id);expect(restored.items[0]?.state).toBe("restored");
    expect(await readFile(c.path)).toEqual(c.bytes);expect(await readFile(`${c.path}.manifest.json`)).toEqual(manifest);
    const database=new DatabaseSync(c.path,{readOnly:true});expect(database.prepare("SELECT id,body_object FROM session_versions").get()).toEqual({id:"head",body_object:body});database.close();
    expect(Buffer.from(await f.objects.get(body)).toString()).toBe("shared old body");
  });

  it("recovers after moving only the main database, keeping references blocked until the manifest joins it",async()=>{
    const f=await fixture(),{plan,candidates,body}=await f.prepare();let once=true;
    const interrupted=f.executor((stage)=>{if(stage === "after-quarantine-move" && once){once=false;throw new Error("synthetic main-only interruption");}});
    await expect(interrupted.quarantine(plan)).rejects.toMatchObject({code:"RECOVERY_REQUIRED"});
    const partial=interrupted.journal.list()[0]!;expect(partial.items[0]?.state).toBe("planned");
    await expect(access(candidates[0]!.path)).rejects.toThrow();await expect(access(`${candidates[0]!.path}.manifest.json`)).resolves.toBeUndefined();
    const during=await f.repository.capture(f.clock());expect(during.blockers.length).toBeGreaterThan(0);
    expect(during.references).toEqual(expect.arrayContaining([expect.objectContaining({source:candidates[0]!.id,targetId:body,reason:"retained-external-database-body"})]));
    expect(Buffer.from(await f.objects.get(body)).toString()).toBe("shared old body");
    const finished=await f.executor().quarantine(plan);expect(finished.items[0]?.state).toBe("quarantined");expect((await f.repository.capture(f.clock())).blockers).toEqual([]);
    await f.executor().restore(finished.id);expect(await readFile(candidates[0]!.path)).toEqual(candidates[0]!.bytes);
  });

  it("restores after an interrupted member restore and refuses new or active SQLite companions",async()=>{
    const f=await fixture(),{plan,candidates}=await f.prepare(),batch=await f.executor().quarantine(plan);let once=true;
    const restore=f.executor((stage)=>{if(stage === "after-restore-move" && once){once=false;throw new Error("synthetic interrupted member restore");}});
    await expect(restore.restore(batch.id)).rejects.toMatchObject({code:"RECOVERY_REQUIRED"});expect((await f.executor().restore(batch.id)).items[0]?.state).toBe("restored");
    await writeFile(`${candidates[0]!.path}-wal`,"synthetic active writer");
    await expect(f.writes.run("verify-again",()=>registerFlatRetentionCandidate(f.repository,candidates[0]!.id,f.clock()))).rejects.toMatchObject({code:"RECOVERY_REQUIRED"});
    expect(await readFile(`${candidates[0]!.path}-wal`,"utf8")).toBe("synthetic active writer");expect(await readFile(candidates[0]!.path)).toEqual(candidates[0]!.bytes);
  });

  it("resumes partial purge and retires only that source; all surviving backups and shared bodies remain readable",async()=>{
    const f=await fixture(),{plan,candidates,body}=await f.prepare(),batch=await f.executor().quarantine(plan);f.later();let once=true;
    const purge=f.executor((stage)=>{if(stage === "after-unlink" && once){once=false;throw new Error("synthetic partial member purge");}});
    await expect(purge.purge(batch.id)).rejects.toMatchObject({code:"RECOVERY_REQUIRED"});
    const purged=await f.executor().purge(batch.id);expect(purged.items[0]?.state).toBe("purged");expect(await f.executor().purge(batch.id)).toEqual(purged);
    expect(f.repository.sources().find((source)=>source.id === candidates[0]!.id)?.retained).toBe(false);
    expect((await f.repository.capture(f.clock())).blockers).toEqual([]);
    for(const c of candidates.slice(1)) expect(await readFile(c.path)).toEqual(c.bytes);
    expect(Buffer.from(await f.objects.get(body)).toString()).toBe("shared old body");
  });

  it("rejects corrupted manifests, absent proof, unknown sidecars and active-database adoption without moving files",async()=>{
    const f=await fixture();await f.addVersion("head");const c=await f.candidate("unknown");
    await writeFile(`${c.path}.manifest.json`,JSON.stringify({schemaVersion:1,candidatePath:c.path,candidateDigest:`sha256:${"0".repeat(64)}`}));
    await expect(registerFlatRetentionCandidate(f.repository,c.id,NOW)).rejects.toMatchObject({code:"BACKUP_CORRUPT"});
    await expect(registerFlatRetentionCandidate(f.repository,"active",NOW)).rejects.toMatchObject({code:"BACKUP_INCOMPLETE"});
    const extra=await f.candidate("extra");await writeFile(`${extra.path}.unknown-journal`,"unknown");
    await expect(registerFlatRetentionCandidate(f.repository,extra.id,NOW)).rejects.toMatchObject({code:"RECOVERY_REQUIRED"});
    expect(await readFile(extra.path)).toEqual(extra.bytes);
  });

  it("keeps retained source bytes unchanged during preview and exposes the static bundle service entry",async()=>{
    const f=await fixture();await f.addVersion("head");const c=await f.candidate("flat");
    const before=(await readdir(f.root)).sort(),dbBefore=await readFile(c.path),manifestBefore=await readFile(`${c.path}.manifest.json`);
    const service=new RetentionService({repository:f.repository,writes:f.writes,clock:f.clock,executionEnabled:true});
    const plan=await service.preview();expect(plan.items.find((item)=>item.kind === "database")?.disposition).toBe("protected");
    expect((await readdir(f.root)).sort()).toEqual(before);expect(await readFile(c.path)).toEqual(dbBefore);expect(await readFile(`${c.path}.manifest.json`)).toEqual(manifestBefore);
    const registered=await service.registerFlatCandidate(c.id);expect(registered.sqliteBundle).toEqual(["flat.sqlite","flat.sqlite.manifest.json"]);
    expect(retentionDigest(service.registry().resources)).toBe(retentionDigest(f.repository.resources()));
  });
});
