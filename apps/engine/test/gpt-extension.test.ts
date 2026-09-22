import { synchronizeGptIndex } from "../src/adapters/gpt-compat/gpt-sync.js";
import { expect, it } from "vitest";
import { createEngineFixture } from "./helpers.js";
import { SqliteExtensionRepository } from "@linmu/dsh-session-store";
import { adapter, summarizeSessionEvents, gptCompatExtensionAdapter } from "@linmu/dsh-session-extension-gpt-compat";
import { ExtensionDataService } from "../src/extensions/service.js";
import { builtInExtensionAdapters } from "../src/extensions/adapters.js";
import { withLauncherNativeExtensions } from "../../../plugins/dsh-session-maintenance/src/config.js";

it("keeps the Harness registry unchanged and indexes plugin events under extension data by instance/profile/session", async () => {
  const f = await createEngineFixture("gpt-extension-index");
  try {
    const registry = f.engine.adapterRegistry.list();
    expect(registry.some(r => r.manifest.id === "dsh-0.1.5")).toBe(true);
    expect(registry.some(r => r.manifest.id === "dsh-gpt-compat")).toBe(false);
    const db = f.engine.repository.database, store = new SqliteExtensionRepository(db);
    const rows = [{type:"context/checkpoint",seq:0,time:1,data:{key:"gpt",state:{input:[{encrypted_content:"synthetic-secret"}]}}},
      {type:"context/checkpoint-commit",seq:1,time:2,data:{checkpoint:0}},
      {type:"request/projection",seq:2,time:3,data:{messages:[],adapterContext:{format:"responses",scope:"test",input:[]}}}];
    const normalized = await adapter.normalizeAppend({runId:"run",operationId:"append",nativeSessionId:"native",nativeRevision:3,observedAt:"2026-09-17T00:00:00Z",
      payload:{header:{version:3,id:"native",createdAt:1,delegationDepth:0,isSeeded:false},events:rows,inheritedEventCount:0,logicalSessionId:"target",instanceId:"copy"}} as never);
    db.exec(`INSERT INTO logical_sessions(id,display_title,sync_mode,archived,labels_json,created_at) VALUES('target','GPT 会话','continuation',0,'[]','2026-09-17');
      INSERT INTO session_versions(id,logical_session_id,body_object,body_hash,metadata_hash,manifest_json,created_at) VALUES('v1','target','fixture','fixture','fixture','{}','2026-09-17');
      UPDATE logical_sessions SET head_version_id='v1' WHERE id='target';
      INSERT INTO projection_runs(id,lease_id,branch_id,instance_id,profile_id,dsh_version,adapter_id,state,started_at,heartbeat_at) VALUES('run','lease','main','copy','web','0.1.5-rc.2','dsh-0.1.5','closed','2026-09-17','2026-09-17');
      INSERT INTO projection_sessions(run_id,native_session_id,logical_session_id,mode,native_revision) VALUES('run','native','target','maintenance-write',3);`);
    let reads = 0;
    const service = new ExtensionDataService(store,builtInExtensionAdapters,async()=>{reads++;return normalized.events;}, { refresh: () => synchronizeGptIndex(store, async () => { reads++; return normalized.events; }) });
    const scope = {instanceId:"copy",profileId:"web",namespace:"gpt-compat"};
    const plugins = [{namespace:scope.namespace,pluginVersion:"0.5.0-dev.3",writerId:"maintenance-gpt-compat-index"}];
    service.connect({instanceId:scope.instanceId,profileId:scope.profileId,plugins});
    service.connect({instanceId:"another-copy",profileId:"web",plugins});
    await service.refreshNativeIndexes();
    expect(service.businessPanels({instanceId:scope.instanceId,profileId:scope.profileId})).toEqual([expect.objectContaining({adapterId:"gpt-compat",status:"ready",objectCount:1})]);
    const objects=service.directory({instanceId:scope.instanceId,profileId:scope.profileId,adapterId:"gpt-compat",level:"objects",ownerSessionId:"target"});
    expect(objects.items).toEqual([expect.objectContaining({readOnly:true,ownerSessionId:"target",kind:"gpt-session-state"})]);
    const object=service.list(scope).items[0]!;
    expect(service.get(scope,object.objectId).summary).toContain("1 个检查点");
    expect(JSON.stringify(service.get(scope,object.objectId))).not.toContain("synthetic-secret");
    expect(service.list({...scope,instanceId:"another-copy"}).items).toHaveLength(0);
    expect(()=>service.write({scope,objectId:object.objectId,writerId:plugins[0]!.writerId,expectedRevision:1,deleted:false,content:store.get(scope,object.objectId)!.content})).toThrow("写入能力");
    await service.refreshNativeIndexes();expect(reads).toBe(1);
    const legacy=normalized.events.map(e=>({...e,extensions:{...e.extensions,adapterId:"dsh-gpt-compat",nativeFormatId:"dsh-gpt-compat-v1-jsonl-zstd"}}));
    expect(summarizeSessionEvents("target","v1",legacy)).toEqual(summarizeSessionEvents("target","v1",normalized.events));
    expect(gptCompatExtensionAdapter.nativeEvents!.types.size).toBe(5);
    service.connect({instanceId:scope.instanceId,profileId:scope.profileId,plugins:[]});await service.refreshNativeIndexes();
    expect(service.panels().find(p=>p.scope.instanceId==="copy")?.status).toBe("disabled");
    expect(service.list(scope).items).toHaveLength(1);
  } finally { await f.cleanupAll(); }
});

it("adds and removes native extension connections without replacing other plugins or Harness settings",()=>{
  const config={connectionId:"primary",dshInstanceId:"copy",profileId:"web",pinnedAdapterId:"dsh-0.1.5",extensionPlugins:[{namespace:"thoughtdag",pluginVersion:"fixture",writerId:"thoughtdag"}]};
  const native={namespace:"gpt-compat",pluginVersion:"0.5.0-dev.3",writerId:"maintenance-gpt-compat-index"};
  const enabled=withLauncherNativeExtensions(config,{DSH_SESSION_MAINTENANCE_NATIVE_EXTENSIONS:JSON.stringify([native])});
  expect(enabled.extensionPlugins).toEqual([...config.extensionPlugins,native]);
  expect(enabled.pinnedAdapterId).toBe("dsh-0.1.5");
  expect(withLauncherNativeExtensions(enabled,{DSH_SESSION_MAINTENANCE_NATIVE_EXTENSIONS:"[]"}).extensionPlugins).toEqual(config.extensionPlugins);
});
