import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backup } from "node:sqlite";
import { expect, it } from "vitest";
import { DEFAULT_RETENTION_POLICY, RetentionExecutor, ZstdContentObjectStore, identifyRetentionRoot, planRetention } from "../src/index.js";
import { MaintenanceWriteCoordinator } from "../src/write-coordinator.js";
import { NOW, retentionFixture } from "./retention-fixture.js";

async function cache(f:Awaited<ReturnType<typeof retentionFixture>>,id:string) {
  const r=await f.resource("cache",id);
  await writeFile(join(r.path,"projection-cache-manifest.json"),JSON.stringify({schemaVersion:1,cacheKey:id,adapterId:"adapter",adapterFingerprint:"a",configurationDigest:"c",lastAppliedRevision:0,sessions:[],workspaces:[],createdAt:NOW,updatedAt:NOW}));
  f.repository.registerResource({...r.entry,lastUsedAt:NOW});return r;
}

it("rejects reverse object-root/source registration and dynamically blocks a legacy unsafe containing cache",async()=>{
  const f=await retentionFixture(),writes=MaintenanceWriteCoordinator.acquire(f.root,"engine");
  try {
    const body=await f.addVersion("body","irreplaceable"),c=await cache(f,"container");await cp(join(f.root,"objects"),join(c.path,"objects"),{recursive:true});
    await expect(f.repository.registerRoot("nested",c.path,"objects")).rejects.toThrow(/governed resource/u);
    const inside=await cache(f,"objects/contained-cache");
    await expect(f.repository.registerRoot("standalone-unused-store",inside.root.path,"objects")).rejects.toThrow(/contain one another/u);
    const root=await identifyRetentionRoot("nested",c.path,"objects");
    f.database.prepare("INSERT INTO retention_roots VALUES (?,?)").run(root.id,JSON.stringify(root));
    const source={id:"external",rootId:"state",relativePath:"metadata.sqlite",objectRootId:"nested",kind:"backup-database" as const,retained:true};
    expect(()=>f.repository.registerSource(source)).toThrow(/namespace/u);
    await expect(f.repository.bindActiveSource("state","metadata.sqlite","nested")).rejects.toThrow(/namespace/u);
    const active=f.repository.sources()[0]!;
    f.database.prepare("UPDATE retention_sources SET object_root_id='nested',source_json=? WHERE id=?").run(JSON.stringify({...active,objectRootId:"nested"}),active.id);
    const inventory=await f.repository.capture(NOW),plan=planRetention(inventory,{...DEFAULT_RETENTION_POLICY,cacheTargetBytes:0});
    expect(inventory.blockers).toEqual(expect.arrayContaining([expect.objectContaining({code:"unsafe-path",source:c.entry.id})]));
    expect(plan.items.find((item)=>item.kind === "content-object")?.disposition).toBe("protected");
    await expect(new RetentionExecutor({repository:f.repository,writes,now:()=>NOW,executionEnabled:true}).quarantine(plan)).rejects.toThrow();
    expect(Buffer.from(await new ZstdContentObjectStore(c.path).get(body)).toString()).toBe("irreplaceable");
  } finally {await writes.close();await f.close();}
});

it("does not let a registered nested sibling hide unknown recovery directories",async()=>{
  const f=await retentionFixture();
  try {
    const known=await cache(f,"group/known");await mkdir(join(known.root.path,"group/unknown"));
    await writeFile(join(known.root.path,"group/unknown/recovery.json"),JSON.stringify({unknown:true,baseProjectionRoot:known.path}));
    const plan=planRetention(await f.repository.capture(NOW),{...DEFAULT_RETENTION_POLICY,cacheTargetBytes:0});
    expect(plan.blockers).toEqual(expect.arrayContaining([expect.objectContaining({code:"unregistered",source:"cache:group/unknown"})]));
    expect(plan.items.find((item)=>item.id === known.entry.id)?.executable).toBe(false);
    expect(await readFile(join(known.root.path,"group/unknown/recovery.json"),"utf8")).toContain("unknown");
  } finally {await f.close();}
});

it("reads external static references but refuses to equate a stable copy with exclusive external ownership",async()=>{
  const f=await retentionFixture(),outside=await mkdtemp(join(tmpdir(),"dsh-sm-external-owner-SYNTHETIC-")),writes=MaintenanceWriteCoordinator.acquire(f.root,"engine");
  try {
    const body=await f.addVersion("body");await cache(f,"cache");await backup(f.database,join(outside,"archive.sqlite"));
    await f.repository.registerRoot("external",outside,"databases");f.repository.registerSource({id:"external",rootId:"external",relativePath:"archive.sqlite",objectRootId:"state",kind:"backup-database",retained:true});
    const inventory=await f.repository.capture(NOW),plan=planRetention(inventory,{...DEFAULT_RETENTION_POLICY,cacheTargetBytes:0});
    expect(inventory.references).toEqual(expect.arrayContaining([expect.objectContaining({source:"external",targetId:body,reason:"retained-external-database-body"})]));
    expect(plan.blockers).toEqual(expect.arrayContaining([expect.objectContaining({source:"external",code:"coordination-unproven"})]));
    await expect(new RetentionExecutor({repository:f.repository,writes,now:()=>NOW,executionEnabled:true}).quarantine(plan)).rejects.toMatchObject({code:"WRITE_CAPABILITY_UNAVAILABLE"});
  } finally {await writes.close();await f.close();await rm(outside,{recursive:true,force:true});}
});
