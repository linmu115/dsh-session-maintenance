import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureSandbox } from "../../../packages/test-support/src/index.js";
import { openMaintenanceDatabase, SqliteExtensionRepository } from "@linmu/dsh-session-store";
import type { ExtensionWrite, ExtensionScope } from "@linmu/dsh-session-contracts";
import { ExtensionDataService } from "../src/extensions/service.js";
import { builtInExtensionAdapters } from "../src/extensions/adapters.js";
import { MaintenanceClient } from "../../../packages/local-api-client/src/index.js";
import { MaintenanceExtensionBridge } from "../../../plugins/dsh-session-maintenance/src/extension-data.js";
import { createEngineFixture, hashTree } from "./helpers.js";

const scope:ExtensionScope={instanceId:"copy",profileId:"web",namespace:"thoughtdag"};
const plugins=[{namespace:"thoughtdag",pluginVersion:"0.4.11",writerId:"dsh-thoughtdag"},{namespace:"annotation",pluginVersion:"0.3.6",writerId:"dsh-annotation-core"}];
const connect={instanceId:scope.instanceId,profileId:scope.profileId,plugins};
const graph=(id="canvas",revision=0,title="画布"):ExtensionWrite=>({scope,objectId:id,writerId:"dsh-thoughtdag",expectedRevision:revision,deleted:false,
  content:{schemaVersion:1,title,references:[{logicalSessionId:"session-a",anchorId:"anchor-a"},{logicalSessionId:"session-b"}],
    body:{nodes:[{id:"a",position:{x:0,y:0},data:{question:"one"}},{id:"b",position:{x:20,y:40},data:{question:"two"}}],edges:[{id:"ab",source:"a",target:"b"}]}}});
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture(){
  const f=await createFixtureSandbox("extension-data");let db=openMaintenanceDatabase(join(f.root,"extension.sqlite"));
  const make=(adapters=builtInExtensionAdapters as readonly typeof builtInExtensionAdapters[number][])=>new ExtensionDataService(new SqliteExtensionRepository(db),adapters);
  cleanups.push(async()=>{db.close();await f.cleanup();});
  return {get db(){return db;},make,reopen(){db.close();db=openMaintenanceDatabase(join(f.root,"extension.sqlite"));return make();}};
}
describe("pluggable extension data",()=>{
  it("round trips two actual plugin shapes and cross-session references without touching session tables",async()=>{
    const f=await fixture(),service=f.make();service.connect(connect);
    const tables=["logical_sessions","session_versions","canonical_events"];
    const before=tables.map(t=>f.db.prepare(`SELECT * FROM ${t}`).all());
    expect(service.write(graph()).status).toBe("saved");
    const annotation:ExtensionWrite={...graph("set-a"),scope:{...scope,namespace:"annotation"},writerId:"dsh-annotation-core",
      content:{schemaVersion:1,title:"批注",references:[{logicalSessionId:"session-a",messageId:"message-1"}],body:{schemaVersion:1,setId:"set-a",profileId:"web",sessionId:"native-a",state:"pending",revision:0,createdAt:1,
        items:[{referenceId:"ref-1",number:1,selectedText:"选区",userComment:"评论",backlinkState:"not-required",sourceType:"dsh-message",locator:{logicalSessionId:"session-a",logicalAnchorId:"anchor-a"}}]}}};
    service.write(annotation);
    expect(service.get(scope,"canvas").object.content.references).toEqual(graph().content.references);
    expect(service.get(annotation.scope,"set-a").summary).toBe("1 条引用");
    expect(service.panels().map(p=>p.objectCount)).toEqual([1,1]);
    expect(tables.map(t=>f.db.prepare(`SELECT * FROM ${t}`).all())).toEqual(before);
    expect(f.db.prepare("SELECT MAX(version) v FROM schema_migrations").get()?.v).toBe(22);
  });
  it("keeps one current state on repeated saves and preserves it through disable, uninstall, missing adapter and restart",async()=>{
    const f=await fixture();let s=f.make();s.connect(connect);s.write(graph());
    for(let i=0;i<100;i++)expect(s.write(graph()).status).toBe("unchanged");
    expect(s.get(scope,"canvas").object.revision).toBe(1);
    s.enable(scope,false);s.connect(connect);expect(s.panels().find(p=>p.scope.namespace==="thoughtdag")?.status).toBe("disabled");
    expect(()=>s.write(graph("canvas",1,"edit"))).toThrow("尚未启用");
    expect(s.list(scope).items[0]).not.toHaveProperty("content");
    s=f.reopen();expect(s.panels().find(p=>p.scope.namespace==="thoughtdag")?.status).toBe("disabled");
    s.enable(scope,true);s.connect({...connect,plugins:[]});expect(()=>s.get(scope,"canvas")).toThrow("尚未启用");
    const missing=f.make([]);expect(missing.panels().every(p=>p.status==="missing-adapter")).toBe(true);
    expect(missing.list(scope).items).toHaveLength(1);
    const detach=missing.register(builtInExtensionAdapters[0]);
    expect(missing.panels().find(p=>p.scope.namespace==="thoughtdag")?.status).toBe("disabled");
    detach();expect(missing.panels().find(p=>p.scope.namespace==="thoughtdag")?.status).toBe("missing-adapter");
    s.connect(connect);expect(s.get(scope,"canvas").object.revision).toBe(1);
    expect(f.db.prepare("SELECT COUNT(*) n FROM extension_objects").get()?.n).toBe(1);
    expect(f.db.prepare("SELECT COUNT(*) n FROM extension_conflicts").get()?.n).toBe(0);
  });
  it("treats Obsidian as a link-only domain and enforces declared read-only capabilities",async()=>{
    const f=await fixture(),s=f.make();const links={...scope,namespace:"obsidian-links"};
    s.connect({...connect,plugins:[{namespace:links.namespace,pluginVersion:"0.3.23",writerId:"obsidian-deepharness-bridge"}]});
    const input:ExtensionWrite={...graph("link"),scope:links,writerId:"obsidian-deepharness-bridge",content:{schemaVersion:1,title:"知识链接",references:[{logicalSessionId:"session-a"}],body:{vaultId:"vault-a",notePath:"note.md",blockId:"block-a",links:[{target:"another.md",relation:"backlink"}],syncState:"synced"}}};
    s.write(input);expect(s.get(links,"link").summary).toContain("note.md");
    expect(()=>s.write({...input,expectedRevision:1,content:{...input.content,body:{...(input.content.body as object),snapshot:"full note"}}})).toThrow();
    const reader={...builtInExtensionAdapters[2],capabilities:{...builtInExtensionAdapters[2].capabilities,write:false}};
    const readOnly=new ExtensionDataService(new SqliteExtensionRepository(f.db),[reader]);
    expect(readOnly.get(links,"link").object.revision).toBe(1);
    expect(()=>readOnly.write({...input,expectedRevision:1})).toThrow("写入能力");
  });
  it("preserves both edits, deduplicates conflict retries, rejects stale resolutions and resolves explicitly",async()=>{
    const f=await fixture(),s=f.make();s.connect(connect);s.write(graph());s.write(graph("canvas",1,"current"));
    const result=s.write(graph("canvas",1,"incoming"));expect(result.status).toBe("conflict");if(result.status!=="conflict")throw new Error();
    expect(result.conflict.current.content.title).toBe("current");expect(result.conflict.incoming.content.title).toBe("incoming");
    expect(s.write(graph("canvas",1,"incoming"))).toEqual(result);
    s.write(graph("canvas",2,"newer"));expect(()=>s.resolve(scope,result.conflict.id,2,"incoming")).toThrow("再次发生变化");
    expect(s.conflict(scope,result.conflict.id).current.content.title).toBe("current");
    const accepted=s.resolve(scope,result.conflict.id,3,"incoming");expect(accepted.object.revision).toBe(4);expect(accepted.object.conflicts).toBe(0);
    expect(s.get(scope,"canvas").object.content.title).toBe("incoming");
  });
  it("retains tombstones, restores by revision and refuses a stale delete",async()=>{
    const f=await fixture(),s=f.make();s.connect(connect);s.write(graph());
    s.write({...graph("canvas",1),deleted:true});expect(s.list(scope).items).toHaveLength(0);
    expect(s.list({...scope,deleted:"deleted"}).items).toHaveLength(1);
    s.write(graph("canvas",2));expect(s.get(scope,"canvas").object.revision).toBe(3);
    const conflict=s.write({...graph("canvas",1),deleted:true});expect(conflict.status).toBe("conflict");
    if(conflict.status==="conflict")s.resolve(scope,conflict.conflict.id,3,"current");
    expect(s.get(scope,"canvas").object.deleted).toBe(false);
  });
  it("paginates metadata only and isolates instance/profile/namespace and write ownership",async()=>{
    const f=await fixture(),s=f.make();s.connect(connect);
    for(let n=0;n<65;n++)s.write(graph(`canvas-${String(n).padStart(3,"0")}`));
    const first=s.list({...scope,limit:30}),second=s.list({...scope,limit:30,after:first.nextCursor!}),third=s.list({...scope,limit:30,after:second.nextCursor!});
    expect([first.items.length,second.items.length,third.items.length]).toEqual([30,30,5]);expect(third.nextCursor).toBeNull();
    expect(new Set([...first.items,...second.items,...third.items].map(o=>o.objectId)).size).toBe(65);
    expect(JSON.stringify(first)).not.toContain('"body"');
    expect(s.list({...scope,profileId:"other"}).items).toHaveLength(0);
    expect(()=>s.write({...graph(),writerId:"intruder"})).toThrow("写入方");
    expect(()=>s.connect({...connect,plugins:[{...plugins[0]!,writerId:"intruder"}]})).toThrow("写入方");
    expect(s.panels().every(p=>p.configured)).toBe(true); // failed connect rolled back
  });
  it("rejects incompatible versions, malformed graphs, oversized edits and bounds unresolved candidates",async()=>{
    const f=await fixture(),s=f.make();s.connect({...connect,plugins:[{...plugins[0]!,pluginVersion:"99.0.0"}]});expect(()=>s.write(graph())).toThrow("尚未启用");
    s.connect(connect);expect(()=>s.write({...graph(),content:{...graph().content,schemaVersion:2}})).toThrow("格式");
    expect(()=>s.write({...graph(),content:{...graph().content,body:{nodes:[],edges:[{id:"a",source:"missing",target:"missing"}]}}})).toThrow("不存在");
    s.write(graph());
    expect(()=>s.write({...graph(),content:{...graph().content,body:{nodes:[],edges:[],large:"x".repeat(600000)}}})).toThrow("512 KiB");
    for(let i=0;i<16;i++)expect(s.write(graph("canvas",0,`candidate-${i}`)).status).toBe("conflict");
    expect(()=>s.write(graph("canvas",0,"overflow"))).toThrow("已有的冲突");
    expect(f.db.prepare("SELECT COUNT(*) n FROM extension_conflicts").get()?.n).toBe(16);
  });
  it("serves authenticated SDK/DSH bridge requests through the real Engine without writing source homes",async()=>{
    const f=await createEngineFixture("extension-http");cleanups.push(f.cleanupAll);
    const before=await Promise.all([hashTree(f.codexHome),hashTree(f.dshHome)]);
    const server=await f.startServer();const client=new MaintenanceClient({origin:server.origin,token:server.token});
    const denied=await fetch(server.origin+"/v1/extensions/panels");expect(denied.status).toBe(401);await denied.arrayBuffer();
    const bridge=new MaintenanceExtensionBridge({current:async()=>({origin:server.origin,token:server.token})},scope,plugins);
    await bridge.connect();expect(await client.listExtensionPanels()).toHaveLength(2);
    await bridge.save("thoughtdag","canvas",0,graph().content);
    expect((await bridge.get("thoughtdag","canvas")).summary).toBe("2 个节点 · 1 条连线");
    expect((await client.listExtensionObjects(scope)).items).toHaveLength(1);
    expect((await bridge.list("thoughtdag")).items[0]).not.toHaveProperty("content");
    await expect(bridge.get("unconfigured","x")).rejects.toThrow("not configured");
    await client.enableExtension(scope,false);await expect(bridge.save("thoughtdag","canvas",1,graph().content)).rejects.toThrow("local edits must be retained");
    expect(await Promise.all([hashTree(f.codexHome),hashTree(f.dshHome)])).toEqual(before);
  });
  it("upgrades a populated schema 21 database without changing existing session rows",async()=>{
    const f=await fixture();
    f.db.exec("INSERT INTO logical_sessions(id,display_title,sync_mode,archived,labels_json,created_at) VALUES('source','untouched','continuation',0,'[]','2026-09-10')");
    const before=f.db.prepare("SELECT * FROM logical_sessions").all();
    f.db.exec("DROP TABLE extension_conflicts; DROP TABLE extension_objects; DROP TABLE extension_connections; DELETE FROM schema_migrations WHERE version=22");
    const upgraded=f.reopen();expect(upgraded.panels()).toEqual([]);expect(f.db.prepare("SELECT * FROM logical_sessions").all()).toEqual(before);
    upgraded.connect(connect);upgraded.write(graph());expect(f.reopen().get(scope,"canvas").object.revision).toBe(1);
  });
});
