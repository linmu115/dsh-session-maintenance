import {expect,it} from 'vitest';
import {REQUIRED_CAPABILITIES} from '@linmu/dsh-session-adapter-0-1-5';
import type {RuntimeBrokerPrepareRunRequest} from '@linmu/dsh-session-contracts';
import {createEngineFixture,hashTree} from './helpers.js';
import {contextEvents,contextHeader} from '../../../packages/adapter-dsh-0-1-5/test/context-fixture.js';
import {MaintenanceKnowledge} from '../../../plugins/dsh-session-maintenance/src/session-knowledge.js';

it('keeps stickers, migrations, links and target-scoped graph metadata separate from real session history',async()=>{
 const f=await createEngineFixture('session-knowledge-rc2');
 try{
  const before=await hashTree(f.dshHome),at='2026-09-14T05:00:00Z';
  const request:RuntimeBrokerPrepareRunRequest={schemaVersion:1,client:{kind:'launcher',id:'knowledge-fixture'},runtimeClientId:'knowledge-runtime',instanceId:'knowledge-copy',profileId:'web',dshVersion:'0.1.5-rc.2',maintenanceEndpoint:'http://127.0.0.1:41781',branchId:'main' as never,pinnedAdapterId:'dsh-0.1.5' as never,projectSelection:{kind:'all'},environment:{runtimeCapabilities:[...REQUIRED_CAPABILITIES],packageVersions:Object.fromEntries(['@deepseek-ai/dsh-session','@deepseek-ai/dsh-session-persistence','@deepseek-ai/dsh-session-format-catalog'].map(n=>[n,'0.1.5-rc.2']))}};
  const run=await f.engine.prepareProjectionRuntimeRun(request);
  await f.engine.attachProjectionRuntimeRun({schemaVersion:1,clientId:request.runtimeClientId,runId:run.runId,temporaryPersistenceRootId:run.temporaryPersistenceRootId,attachedAt:at,nativeMode:run.nativeMode});
  const header={...contextHeader,cwd:f.root};const ids:Record<string,string>={};
  for(const nativeSessionId of ['source','target','other'])ids[nativeSessionId]=(await f.engine.registerProjectionRuntimeSession({schemaVersion:1,clientId:request.runtimeClientId,runId:run.runId,nativeSessionId:nativeSessionId as never,header:{...header,id:nativeSessionId},title:nativeSessionId})).logicalSessionId;
  const scope={instanceId:request.instanceId,profileId:'web'};
  f.engine.extensions!.connect({...scope,plugins:[{namespace:'stickers',pluginVersion:'0.7.4-rc2.3',writerId:'dsh-session-sticker-board'},{namespace:'obsidian-links',pluginVersion:'0.7.0-rc2.1',writerId:'obsidian-deepharness-bridge'},{namespace:'thoughtdag',pluginVersion:'0.4.14-rc2.14',writerId:'dsh-thoughtdag'},{namespace:'annotation-upstream',pluginVersion:'0.3.12-rc2.19',writerId:'dsh-annotation-core'}]});
  const api=f.engine.sessionKnowledge;
  const sessionCount=()=>f.engine.repository.database.prepare('SELECT COUNT(*) n FROM logical_sessions').get()!.n;
  const count=sessionCount();
  const sticker={namespace:'stickers' as const,objectId:'sticker-one',expectedRevision:0,title:'独立讨论',body:{kind:'session' as const,logicalSessionId:ids.target!}};
  expect((await api.write(run.runId,sticker)).status).toBe('saved');expect((await api.write(run.runId,sticker)).status).toBe('unchanged');
  expect(sessionCount()).toBe(count);
  expect((await api.write(run.runId,{...sticker,title:'相冲突编辑'})).status).toBe('conflict');
  await expect(api.write(run.runId,{...sticker,objectId:'foreign',body:{kind:'session',logicalSessionId:'outside'}})).rejects.toThrow();
  const migrated={migrationId:'migration-one',vaultId:'vault-one',nativeSessionId:'source',sourceDigest:'a'.repeat(64),sourceRevision:'sha256:legacy',phase:'stage' as const,stickers:[{legacyId:'old-id',title:'原贴纸',record:{stickerId:'old-id',markdown:'用户注释',quote:'重点'}}]};
  const staged=await api.migration(run.runId,migrated);expect(staged.mappings).toHaveLength(1);
  expect((await api.list(run.runId,{namespace:'stickers'})).items.map(i=>i.objectId)).not.toContain(staged.mappings[0]!.objectId);
  await expect(api.get(run.runId,'stickers',staged.mappings[0]!.objectId)).rejects.toThrow();
  await expect(api.legacyState(run.runId,'source')).rejects.toThrow();
  expect((await api.migration(run.runId,migrated)).mappings).toEqual(staged.mappings);
  await expect(api.migration(run.runId,{...migrated,sourceDigest:'b'.repeat(64)})).rejects.toThrow();
  await expect(api.migration(run.runId,{...migrated,phase:'activate',stickers:[]})).rejects.toThrow('集合');
  await expect(api.migration(run.runId,{...migrated,phase:'activate',sourceRevision:'changed'})).rejects.toThrow('回执');
  await expect(api.migration(run.runId,{...migrated,phase:'activate',stickers:[{...migrated.stickers[0]!,record:{stickerId:'old-id',markdown:'changed'}}]})).rejects.toThrow('核对');
  await expect(api.migration(run.runId,{...migrated,phase:'activate',pendingBacklinkDeletes:[{stickerId:'changed'}]})).rejects.toThrow('核对');
  const stickerScope={...scope,namespace:'stickers'},stagedObject=f.engine.extensions!.get(stickerScope,staged.mappings[0]!.objectId).object;
  const modifyStaged=(content:any,deleted=false)=>f.engine.extensions!.write({scope:stickerScope,objectId:stagedObject.objectId,writerId:stagedObject.writerId,expectedRevision:f.engine.extensions!.get(stickerScope,stagedObject.objectId).object.revision,content,deleted});
  for(const changed of [
    {...stagedObject.content,title:'changed title'},
    {...stagedObject.content,body:{...(stagedObject.content.body as any),logicalSessionId:ids.target}},
    {...stagedObject.content,body:{...(stagedObject.content.body as any),legacyStickerId:'changed-id'}},
    {...stagedObject.content,body:{...(stagedObject.content.body as any),migrationId:'changed-migration'}},
    {...stagedObject.content,references:[{logicalSessionId:ids.target!}]},
    {...stagedObject.content,body:{kind:'session',logicalSessionId:ids.source}},
  ]){
    expect(modifyStaged(changed).status).toBe('saved');
    await expect(api.migration(run.runId,{...migrated,phase:'activate'})).rejects.toThrow('完整核对');
    modifyStaged(stagedObject.content);
  }
  modifyStaged(stagedObject.content,true);await expect(api.migration(run.runId,{...migrated,phase:'activate'})).rejects.toThrow('完整核对');modifyStaged(stagedObject.content);
  const activated=await api.migration(run.runId,{...migrated,phase:'activate'});expect(activated.object.content.body).toMatchObject({phase:'active'});
  const legacy=await api.legacyState(run.runId,'source');
  const update={document:{sessionId:'source',stickers:[{stickerId:'old-id',sessionId:'source',markdown:'合法新内容',quote:'重点'}]},expectedRevision:legacy.document.revision};
  const saved=await api.legacySave(run.runId,update);expect(saved.document.revision).not.toBe(legacy.document.revision);
  await expect(api.legacySave(run.runId,update)).rejects.toThrow('另一窗口');
  expect((await api.migration(run.runId,{...migrated,phase:'activate'})).verification).toBe('manifest-verified');
  expect((await api.legacyState(run.runId,'source')).document).toEqual(saved.document);
  const pending={stickerId:'deleted-sticker',sessionId:'source',pendingVaultIds:['vault-one','vault-two']};
  const enqueued=await api.legacySave(run.runId,{document:saved.document,expectedRevision:saved.document.revision,enqueueBacklinkDelete:pending});
  const partial=await api.legacySave(run.runId,{document:enqueued.document,expectedRevision:enqueued.document.revision,updateBacklinkDelete:{...pending,pendingVaultIds:['vault-two']}});
  expect(partial.pendingBacklinkDeletes).toEqual([{...pending,pendingVaultIds:['vault-two']}]);
  await expect(api.legacySave(run.runId,{document:partial.document,expectedRevision:partial.document.revision,updateBacklinkDelete:{...pending,pendingVaultIds:['new-vault']}})).rejects.toThrow('改投');
  await expect(api.legacySave(run.runId,{document:enqueued.document,expectedRevision:enqueued.document.revision,updateBacklinkDelete:{...pending,pendingVaultIds:[]}})).rejects.toThrow('另一窗口');
  const completed=await api.legacySave(run.runId,{document:partial.document,expectedRevision:partial.document.revision,acknowledgeStickerId:pending.stickerId});
  expect(completed.pendingBacklinkDeletes).toEqual([]);

  await expect(api.migration(run.runId,{...migrated,phase:'activate',stickers:[{...migrated.stickers[0]!,title:'changed incoming title'}]})).rejects.toThrow('完整内容核对');
  await expect(api.migration(run.runId,{...migrated,phase:'activate',stickers:[{...migrated.stickers[0]!,record:{changed:true}}]})).rejects.toThrow('完整内容核对');
  expect(sessionCount()).toBe(count);
  const note={namespace:'obsidian-links' as const,objectId:'note-one',expectedRevision:0,title:'笔记关联',body:{kind:'note-link' as const,note:{vaultId:'vault-one',noteId:'stable-note',notePath:'旧名.md'},logicalSessionId:ids.target!,syncState:'synced' as const}};
  await api.write(run.runId,note);await api.write(run.runId,{...note,expectedRevision:1,body:{...note.body,note:{...note.body.note,notePath:'移动/新名.md'}}});
  expect((await api.get(run.runId,'obsidian-links','note-one')).content.body).toMatchObject({note:{noteId:'stable-note',notePath:'移动/新名.md'}});
  const canvas={scope:{...scope,namespace:'thoughtdag'},objectId:'canvas-one',writerId:'dsh-thoughtdag',expectedRevision:0,deleted:false,content:{schemaVersion:1,title:'共享画布',references:[{logicalSessionId:ids.target!}],body:{managedSchema:1,nodes:[{id:'n',position:{x:0,y:0},data:{kind:'session',label:'目标',logicalSessionId:ids.target!}}],edges:[]}}};
  f.engine.extensions!.write(canvas);f.engine.extensions!.write({...canvas,objectId:'canvas-two'});
  await api.write(run.runId,{...sticker,expectedRevision:1,deleted:true});expect(sessionCount()).toBe(count);
  expect((await api.list(run.runId,{namespace:'stickers',deleted:'deleted'})).items.map(i=>i.objectId)).toContain('sticker-one');
  await api.write(run.runId,{...sticker,expectedRevision:2});
  const events=contextEvents(false);
  const append=async(value:any[],operationId:string)=>f.engine.appendProjectionRuntimeEvent(request.runtimeClientId,{runId:run.runId,nativeSessionId:'source' as never,operationId:operationId as never,nativeRevision:value.at(-1).seq+1,observedAt:at,payload:{logicalSessionId:ids.source!,instanceId:request.instanceId,header:{...header,id:'source'},inheritedEventCount:0,events:value}});
  expect((await append(events,'first')).status).toBe('committed');
  const ref=await f.engine.sessionContext.capture({runId:run.runId,sourceNativeSessionId:'source',targetNativeSessionId:'target',operationId:'ref',anchorId:'reply-one',selectedText:'重点'});await f.engine.sessionContext.bind(run.runId,'target',ref.referenceId,'user-one');
  await append(contextEvents().slice(7),'next');
  expect((await f.engine.sessionContext.inspect(run.runId,'target',ref.referenceId)).sourceVersionId).toBe(ref.sourceVersionId);
  await f.engine.appendProjectionRuntimeEvent(request.runtimeClientId,{runId:run.runId,nativeSessionId:'target' as never,operationId:'target-turn' as never,nativeRevision:events.at(-1)!.seq+1,observedAt:at,payload:{logicalSessionId:ids.target!,instanceId:request.instanceId,header:{...header,id:'target'},inheritedEventCount:0,events}});
  await expect(f.engine.sessionContext.capture({runId:run.runId,sourceNativeSessionId:'target',targetNativeSessionId:'source',operationId:'cyclic',anchorId:'reply-one',selectedText:'重点'})).rejects.toThrow('循环');
  const reverse=await f.engine.sessionContext.capture({runId:run.runId,sourceNativeSessionId:'target',targetNativeSessionId:'other',operationId:'reverse',anchorId:'reply-one',selectedText:'重点'});
  await f.engine.sessionContext.bind(run.runId,'other',reverse.referenceId,'reverse-user');
  expect((await f.engine.sessionGraph.relations(run.runId,ids.target!)).items.map(item=>item.referenceId)).toEqual([ref.referenceId]);
  expect((await f.engine.sessionGraph.relations(run.runId,ids.other!)).items.map(item=>item.referenceId)).toEqual([reverse.referenceId]);
  await expect(f.engine.sessionGraph.relations(run.runId,'foreign')).rejects.toThrow();
  for(let i=0;i<60;i++)await api.write(run.runId,{...sticker,title:'分页贴纸'+i,objectId:'page-'+String(i).padStart(3,'0')});
  const first=await api.list(run.runId,{namespace:'stickers'});expect(first.items).toHaveLength(30);expect(first.nextCursor).toBeTruthy();
  const next=await api.list(run.runId,{namespace:'stickers',after:first.nextCursor!});expect(new Set([...first.items,...next.items].map(i=>i.objectId)).size).toBe(60);
  f.engine.extensions!.enable({...scope,namespace:'stickers'},false);await expect(api.write(run.runId,sticker)).rejects.toThrow();
  const server=await f.startServer();expect((await fetch(server.origin+'/v1/session-knowledge/network',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({runId:run.runId,input:{}})})).status).toBe(401);
  f.engine.extensions!.enable({...scope,namespace:'stickers'},true);
  const host=new MaintenanceKnowledge({current:async()=>({origin:server.origin,token:server.token})},run.runId,{} as never);
  expect((await host.request('status') as any).instanceId).toBe(request.instanceId);
  expect((await host.request('write',{...sticker,objectId:'http-sticker'}) as any).status).toBe('saved');
  expect((await host.request('get',{namespace:'stickers',objectId:'http-sticker'}) as any).content.body.logicalSessionId).toBe(ids.target);
  expect((await host.request('list',{namespace:'stickers'}) as any).items.length).toBeGreaterThan(0);
  const fromHttp=await host.request('legacy-state',{nativeSessionId:'source'}) as any;
  expect((await host.request('legacy-save',{document:fromHttp.document,expectedRevision:fromHttp.document.revision}) as any).document.sessionId).toBe('source');
  await expect(host.request('list',{runId:'different'})).rejects.toThrow('当前实例');
  await expect(host.request('network',{})).rejects.toThrow('不支持');
  await expect(host.request('impact',{})).rejects.toThrow('不支持');
  const retired=await fetch(server.origin+'/v1/session-knowledge/network',{method:'POST',headers:{authorization:`Bearer ${server.token}`,'content-type':'application/json'},body:JSON.stringify({runId:run.runId,input:{}})});expect(retired.status).toBe(404);
  const two={...migrated,migrationId:'target-migration',nativeSessionId:'target',stickers:[{legacyId:'a',title:'A',record:{stickerId:'a'}},{legacyId:'b',title:'B',record:{stickerId:'b'}}]};
  const twoStaged=await api.migration(run.runId,two);
  // A pre-upgrade staged receipt gains the digest only after complete object verification.
  const withoutDigest={...(twoStaged.object.content.body as any)};delete withoutDigest.manifestDigest;
  f.engine.extensions!.write({scope:stickerScope,objectId:twoStaged.object.objectId,writerId:twoStaged.object.writerId,expectedRevision:twoStaged.object.revision,content:{...twoStaged.object.content,body:withoutDigest},deleted:false});
  await expect(api.migration(run.runId,{...two,phase:'activate',stickers:two.stickers.slice(0,1)})).rejects.toThrow('集合');
  const twoActive=await api.migration(run.runId,{...two,phase:'activate',stickers:[...two.stickers].reverse()});
  expect(twoActive.mappings).toHaveLength(2);expect((twoActive.object.content.body as any).manifestDigest).toMatch(/^[a-f0-9]{64}$/);
  // A pre-upgrade active receipt is reported as historical evidence only, with no writes.
  const oldActive={...(twoActive.object.content.body as any)};delete oldActive.manifestDigest;
  f.engine.extensions!.write({scope:stickerScope,objectId:twoActive.object.objectId,writerId:twoActive.object.writerId,expectedRevision:twoActive.object.revision,content:{...twoActive.object.content,body:oldActive},deleted:false});
  const rowsBefore=f.engine.repository.database.prepare('SELECT * FROM extension_objects ORDER BY namespace,object_id').all();
  expect((await api.migration(run.runId,{...two,phase:'activate',stickers:two.stickers.map(item=>({...item,record:{unverified:true}}))})).verification).toBe('legacy-receipt-only');
  expect(f.engine.repository.database.prepare('SELECT * FROM extension_objects ORDER BY namespace,object_id').all()).toEqual(rowsBefore);
  const oldState=await api.legacyState(run.runId,'target');
  const oldEdited=await api.legacySave(run.runId,{document:{sessionId:'target',stickers:oldState.document.stickers.map((item:any)=>({...item,sessionId:'target',markdown:'legitimate legacy edit'}))},expectedRevision:oldState.document.revision});
  expect((await api.migration(run.runId,{...two,phase:'activate'})).verification).toBe('legacy-receipt-only');
  expect((await api.legacyState(run.runId,'target')).document).toEqual(oldEdited.document);
  await f.engine.sessionContext.bind(run.runId,'other',reverse.referenceId,null);
  expect((await f.engine.sessionGraph.relations(run.runId,ids.other!)).items[0]?.state).toBe('revoked');
  expect(await hashTree(f.dshHome)).toBe(before);
 }finally{await f.cleanupAll();}
},60000);
