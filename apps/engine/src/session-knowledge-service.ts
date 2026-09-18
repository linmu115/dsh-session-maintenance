import { createHash } from 'node:crypto';
import {
  ExtensionDataError, knowledgeWriteSchema, knowledgeListSchema, knowledgeMigrationSchema, stickerMigrationSchema,
  type KnowledgeWrite, type KnowledgeList, type KnowledgeMigration, type KnowledgeMigrationReceipt,
  type ExtensionObject, type ExtensionWriteResult, type KnowledgePage,
  type RunId, jsonValueSchema,
} from '@linmu/dsh-session-contracts';
import type { SessionMaintenanceEngine } from './engine.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function stable(value:unknown):string {if(Array.isArray(value))return '['+value.map(stable).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable((value as Record<string,unknown>)[k])).join(',')+'}';return JSON.stringify(value);}
const fail=(code:string,message:string)=>new ExtensionDataError(code,message,409);
const visible="ps.mode NOT IN ('hidden','recovery-only') AND s.tombstoned_at IS NULL";
// Staged imports are inaccessible until their durable migration receipt is active.
const activeImport=`(json_extract(o.content_json,'$.body.migrationId') IS NULL OR EXISTS(
  SELECT 1 FROM extension_objects m WHERE m.instance_id=o.instance_id AND m.profile_id=o.profile_id AND m.namespace='stickers' AND m.deleted=0
  AND json_extract(m.content_json,'$.body.kind')='migration' AND json_extract(m.content_json,'$.body.phase')='active'
  AND json_extract(m.content_json,'$.body.migrationId')=json_extract(o.content_json,'$.body.migrationId')))`;
export class SessionKnowledgeService {
  constructor(private readonly engine:SessionMaintenanceEngine) {}
  private async context(runId:string,namespace?:string) {
    const run=await this.engine.projectionRunRepository.getProjectionRun(runId as RunId);
    if(!run||run.state!=='running')throw fail('KNOWLEDGE_UNAVAILABLE','当前实例的会话空间尚未就绪');
    const extensions=this.engine.extensions;if(!extensions)throw fail('KNOWLEDGE_UNAVAILABLE','扩展数据未接通');
    const scope={instanceId:run.instanceId,profileId:run.profileId,namespace:namespace??'stickers'};
    const panel=extensions.panels().find(p=>p.scope.instanceId===run.instanceId&&p.scope.profileId===run.profileId&&p.scope.namespace===scope.namespace);
    if(namespace&&panel?.status!=='ready')throw fail('KNOWLEDGE_UNAVAILABLE','此实例未启用匹配的数据扩展；原对象仍保留');
    return {run,extensions,scope,writerId:panel?.writerId??''};
  }
  async status(runId:string) {
    const {run,extensions}=await this.context(runId);
    return {protocolVersion:1,instanceId:run.instanceId,profileId:run.profileId,panels:extensions.panels().filter(p=>p.scope.instanceId===run.instanceId&&p.scope.profileId===run.profileId)};
  }
  async get(runId:string,namespace:string,objectId:string) {
    const {scope,extensions}=await this.context(runId,namespace);
    const object=extensions.get(scope,objectId).object;
    if(namespace==='stickers'&&!this.engine.repository.database.prepare(`SELECT 1 FROM extension_objects o WHERE instance_id=? AND profile_id=? AND namespace=? AND object_id=? AND ${activeImport}`).get(scope.instanceId,scope.profileId,namespace,objectId))throw fail('STICKER_MIGRATION_REQUIRED','此对象的迁移尚未完成');
    for(const ref of object.content.references)await this.engine.sessionGraph.resolve(runId,{logicalSessionId:ref.logicalSessionId});
    return object;
  }
  async list(runId:string,input:KnowledgeList):Promise<KnowledgePage> {
    const q=knowledgeListSchema.parse(input),{scope,extensions}=await this.context(runId,q.namespace);
    if(q.logicalSessionId)await this.engine.sessionGraph.resolve(runId,{logicalSessionId:q.logicalSessionId});
    const rows=this.engine.repository.database.prepare(`SELECT object_id FROM extension_objects o WHERE instance_id=? AND profile_id=? AND namespace=? AND object_id>?
      ${q.deleted==='all'?'':'AND deleted='+(q.deleted==='deleted'?'1':'0')}
      AND json_extract(content_json,'$.body.kind') IN ('session','annotation','note-link')
      AND ${activeImport}
      ${q.logicalSessionId?"AND json_extract(content_json,'$.body.logicalSessionId')=?":''}
      AND NOT EXISTS(SELECT 1 FROM json_each(o.content_json,'$.references') ref WHERE NOT EXISTS
        (SELECT 1 FROM projection_sessions ps JOIN logical_sessions s ON s.id=ps.logical_session_id WHERE ps.run_id=? AND ${visible} AND ps.logical_session_id=json_extract(ref.value,'$.logicalSessionId')))
      ORDER BY object_id LIMIT 31`).all(scope.instanceId,scope.profileId,scope.namespace,q.after??'',...(q.logicalSessionId?[q.logicalSessionId]:[]),runId) as {object_id:string}[];
    const items: ExtensionObject[] = []; let bytes = 0;
    for (const row of rows.slice(0,30)) {
      const object = extensions.get(scope,row.object_id).object, size = Buffer.byteLength(JSON.stringify(object));
      if (items.length && bytes + size > 700 * 1024) break;
      items.push(object); bytes += size;
    }
    return {items,nextCursor:rows.length>items.length?items.at(-1)!.objectId:null};
  }
  async write(runId:string,input:KnowledgeWrite):Promise<ExtensionWriteResult> {
    const q=knowledgeWriteSchema.parse(input),{scope,extensions,writerId}=await this.context(runId,q.namespace);
    if((q.namespace==='obsidian-links')!==(q.body.kind==='note-link'))throw fail('KNOWLEDGE_TYPE','数据域和对象类型不一致');
    if(q.body.kind==='annotation'){
      const identity=await this.engine.sessionGraph.resolve(runId,{logicalSessionId:q.body.logicalSessionId});
      await this.legacyContext(runId,identity.nativeSessionId);
      if(q.expectedRevision>0)await this.get(runId,q.namespace,q.objectId);
    }
    const refs=[q.body.logicalSessionId];if(q.body.kind==='session'&&q.body.source)refs.push(q.body.source.logicalSessionId);
    for(const logicalSessionId of refs)await this.engine.sessionGraph.resolve(runId,{logicalSessionId});
    if(q.expectedRevision===0&&q.body.kind==='session'&&q.body.source) {
      const source=q.body.source;
      const preview=await this.engine.sessionGraph.preview(runId,source.logicalSessionId,undefined,{sourceVersionId:source.sourceVersionId,sourceAnchorId:source.sourceAnchorId});
      if(source.locator && source.locator.messageId!==preview.capture.messageId)throw fail('KNOWLEDGE_SOURCE','贴纸标记必须使用已核验的原生回复身份');
      if(source.referenceId) {
        const target=await this.engine.sessionGraph.resolve(runId,{logicalSessionId:q.body.logicalSessionId});
        const {record}=await this.engine.sessionContext.record(runId,target.nativeSessionId,source.referenceId);
        if(record.sourceSessionId!==source.logicalSessionId||record.sourceVersionId!==source.sourceVersionId||record.sourceAnchorId!==source.sourceAnchorId)
          throw fail('KNOWLEDGE_SOURCE','贴纸来源与权威引用不一致');
      }
    }
    return extensions.write({scope,writerId,objectId:q.objectId,expectedRevision:q.expectedRevision,deleted:q.deleted,
      content:{schemaVersion:q.namespace==='obsidian-links'?2:1,title:q.title,body:jsonValueSchema.parse(JSON.parse(JSON.stringify(q.body))),references:[...new Set(refs)].map(logicalSessionId=>({logicalSessionId}))}});
  }
  async migration(runId:string,input:KnowledgeMigration):Promise<KnowledgeMigrationReceipt> {
    const q=knowledgeMigrationSchema.parse(input),{scope,extensions,writerId}=await this.context(runId,'stickers');
    const identity=await this.engine.sessionGraph.resolve(runId,{nativeSessionId:q.nativeSessionId});
    const objectId='migration-'+hash(q.vaultId+'\0'+q.nativeSessionId).slice(0,40);
    if(new Set(q.stickers.map(s=>s.legacyId)).size!==q.stickers.length)throw fail('MIGRATION_CONFLICT','旧对象身份重复');
    const mappings=q.stickers.map(s=>({legacyId:s.legacyId,objectId:'legacy-'+hash(q.vaultId+'\0'+identity.logicalSessionId+'\0'+s.legacyId).slice(0,40)}));
    const expected=q.stickers.map((sticker,index)=>({objectId:mappings[index]!.objectId,writerId,deleted:false,content:{
      schemaVersion:1,title:sticker.title||'贴纸',body:{kind:'annotation',logicalSessionId:identity.logicalSessionId,legacyStickerId:sticker.legacyId,record:sticker.record,migrationId:q.migrationId},
      references:[{logicalSessionId:identity.logicalSessionId}],
    }}));
    // Keep one content digest, not a second snapshot of imported sticker bodies.
    const manifestDigest=hash(stable({migrationId:q.migrationId,vaultId:q.vaultId,nativeSessionId:q.nativeSessionId,
      logicalSessionId:identity.logicalSessionId,sourceRevision:q.sourceRevision,sourceDigest:q.sourceDigest,
      objects:[...expected].sort((a,b)=>a.objectId.localeCompare(b.objectId)),pendingBacklinkDeletes:q.pendingBacklinkDeletes}));
    let previous:ExtensionObject|undefined;
    try{previous=extensions.get(scope,objectId).object;}catch(e){if(!(e instanceof ExtensionDataError)||e.code!=='EXTENSION_NOT_FOUND')throw e;}
    if(previous){const old=stickerMigrationSchema.parse(previous.content.body);if(previous.deleted||old.vaultId!==q.vaultId||old.legacySessionId!==q.nativeSessionId||old.sourceDigest!==q.sourceDigest||old.sourceRevision!==q.sourceRevision||old.migrationId!==q.migrationId||old.logicalSessionId!==identity.logicalSessionId)throw fail('MIGRATION_CONFLICT','旧对象与迁移回执不一致，请先解决冲突');
      const requestedIds=q.stickers.map(item=>item.legacyId).sort();
      if(stable(old.mappings.map(item=>item.legacyId).sort())!==stable(requestedIds))throw fail('MIGRATION_CONFLICT','迁移对象集合与暂存回执不一致，请重试完整迁移');
      if(stable([...old.mappings].sort((a,b)=>a.legacyId.localeCompare(b.legacyId)))!==stable([...mappings].sort((a,b)=>a.legacyId.localeCompare(b.legacyId))))throw fail('MIGRATION_CONFLICT','迁移对象身份与回执不一致');
      if(old.manifestDigest&&old.manifestDigest!==manifestDigest)throw fail('MIGRATION_VERIFY_FAILED','迁移请求完整内容核对失败');
      if(old.phase==='active') {
        // Old active receipts have no immutable payload proof. Report only that
        // prior decision; never validate new data against legitimately edited objects.
        return {object:previous,mappings:old.mappings,verification:old.manifestDigest?'manifest-verified' as const:'legacy-receipt-only' as const};
      }
      if(stable(old.pendingBacklinkDeletes)!==stable(q.pendingBacklinkDeletes))throw fail('MIGRATION_VERIFY_FAILED','迁移待清理双链核对失败');
    }
    if(q.phase==='activate'&&!previous)throw fail('MIGRATION_NOT_STAGED','必须先完成导入与回执核对');
    return extensions.transaction(()=>{
      if(q.phase==='stage')for(const value of expected){
        const result=extensions.write({scope,...value,expectedRevision:0});
        if(result.status==='conflict')throw fail('MIGRATION_CONFLICT','迁移目标存在不同编辑，已保留旧写入冻结状态');
      }
      for(const intended of expected){
        const value=extensions.get(scope,intended.objectId).object;
        if(stable({objectId:value.objectId,writerId:value.writerId,deleted:value.deleted,content:value.content})!==stable(intended))throw fail('MIGRATION_VERIFY_FAILED','迁移对象完整核对失败');
      }
      const body={kind:'migration' as const,migrationId:q.migrationId,vaultId:q.vaultId,legacySessionId:q.nativeSessionId,logicalSessionId:identity.logicalSessionId,sourceDigest:q.sourceDigest,sourceRevision:q.sourceRevision,manifestDigest,phase:q.phase==='stage'?'staged' as const:'active' as const,mappings,pendingBacklinkDeletes:q.pendingBacklinkDeletes};
      const saved=extensions.write({scope,writerId,objectId,expectedRevision:previous?.revision??0,deleted:false,content:{schemaVersion:1,title:'旧贴纸迁移',body,references:[{logicalSessionId:identity.logicalSessionId}]}});
      if(saved.status==='conflict')throw fail('MIGRATION_CONFLICT','迁移回执已改变');return {object:saved.object,mappings,verification:'manifest-verified' as const};
    });
  }
  private async legacyContext(runId:string,nativeSessionId:string) {
    const context=await this.context(runId,'stickers'),identity=await this.engine.sessionGraph.resolve(runId,{nativeSessionId});
    const db=this.engine.repository.database;
    const markers=db.prepare(`SELECT object_id FROM extension_objects WHERE instance_id=? AND profile_id=? AND namespace='stickers' AND deleted=0 AND json_extract(content_json,'$.body.kind')='migration' AND json_extract(content_json,'$.body.logicalSessionId')=?`).all(context.scope.instanceId,context.scope.profileId,identity.logicalSessionId) as {object_id:string}[];
    if(markers.length!==1)throw fail('STICKER_MIGRATION_REQUIRED','请先迁移此会话的旧贴纸；当前不会覆盖旧数据');
    const marker=context.extensions.get(context.scope,markers[0]!.object_id).object,body=stickerMigrationSchema.parse(marker.content.body);
    if(body.phase!=='active')throw fail('STICKER_MIGRATION_REQUIRED','旧贴纸迁移尚未完成，请重试原迁移');
    const rows=db.prepare(`SELECT object_id FROM extension_objects WHERE instance_id=? AND profile_id=? AND namespace='stickers' AND deleted=0 AND json_extract(content_json,'$.body.kind')='annotation' AND json_extract(content_json,'$.body.logicalSessionId')=? ORDER BY object_id LIMIT 501`).all(context.scope.instanceId,context.scope.profileId,identity.logicalSessionId) as {object_id:string}[];
    if(rows.length>500)throw fail('STICKER_LIMIT','此会话贴纸超过本次加载额度，请在扩展面板分批整理');
    const objects=rows.map(r=>context.extensions.get(context.scope,r.object_id).object);
    const stickers=objects.map(o=>(o.content.body as {record:unknown}).record);
    const document={protocolVersion:1,type:'session-note',sessionId:nativeSessionId,revision:'sha256:'+hash(stable([[marker.objectId,marker.revision],...objects.map(o=>[o.objectId,o.revision])])),stickers};
    if(Buffer.byteLength(JSON.stringify(document))>512*1024)throw fail('STICKER_LIMIT','此会话贴纸超过本次读取额度');
    return {...context,identity,marker,body,objects,document};
  }
  async legacyState(runId:string,nativeSessionId:string) {
    const c=await this.legacyContext(runId,nativeSessionId);return {document:c.document,pendingBacklinkDeletes:c.body.pendingBacklinkDeletes};
  }
  async legacySave(runId:string,input:{document:{sessionId:string;stickers:unknown[]};expectedRevision:string;enqueueBacklinkDelete?:unknown;updateBacklinkDelete?:unknown;acknowledgeStickerId?:string|undefined}) {
    const c=await this.legacyContext(runId,input.document.sessionId);
    if(c.document.revision!==input.expectedRevision)throw fail('REVISION_CONFLICT','贴纸已在另一窗口修改，请重新读取');
    if(input.document.stickers.length>500)throw fail('STICKER_LIMIT','此会话最多处理 500 张贴纸');
    const records=input.document.stickers as {stickerId:string;sessionId:string;quote?:string;markdown?:string}[];
    if(records.some(r=>!r||typeof r.stickerId!=='string'||r.stickerId.length>256||r.sessionId!==input.document.sessionId)||new Set(records.map(r=>r.stickerId)).size!==records.length)throw fail('STICKER_IDENTITY','贴纸身份与会话不一致');
    c.extensions.transaction(()=>{
      const remain=new Set(records.map(r=>r.stickerId));
      for(const record of records){
        const previous=c.objects.find(o=>(o.content.body as {legacyStickerId:string}).legacyStickerId===record.stickerId);
        const objectId=previous?.objectId??'legacy-'+hash(c.body.vaultId+'\0'+c.identity.logicalSessionId+'\0'+record.stickerId).slice(0,40);
        const saved=c.extensions.write({scope:c.scope,writerId:c.writerId,objectId,expectedRevision:previous?.revision??0,deleted:false,content:{schemaVersion:1,title:(record.quote??record.markdown??'贴纸').slice(0,500),body:{kind:'annotation',logicalSessionId:c.identity.logicalSessionId,legacyStickerId:record.stickerId,record:record as never},references:[{logicalSessionId:c.identity.logicalSessionId}]}});if(saved.status==='conflict')throw fail('REVISION_CONFLICT','贴纸保存冲突');
      }
      for(const object of c.objects)if(!remain.has((object.content.body as {legacyStickerId:string}).legacyStickerId)){const saved=c.extensions.write({scope:c.scope,writerId:c.writerId,objectId:object.objectId,expectedRevision:object.revision,deleted:true,content:object.content});if(saved.status==='conflict')throw fail('REVISION_CONFLICT','贴纸删除冲突');}
      let pending=c.body.pendingBacklinkDeletes;
      if(input.enqueueBacklinkDelete&&!pending.some(r=>(r as {stickerId:string}).stickerId===(input.enqueueBacklinkDelete as {stickerId:string}).stickerId))pending=[...pending,input.enqueueBacklinkDelete as never];
      if(input.updateBacklinkDelete){
        const item=jsonValueSchema.parse(input.updateBacklinkDelete) as {stickerId?:unknown;sessionId?:unknown;pendingVaultIds?:unknown};
        if(!item||typeof item.stickerId!=='string'||item.sessionId!==input.document.sessionId||!Array.isArray(item.pendingVaultIds)
          ||item.pendingVaultIds.some(id=>typeof id!=='string'||!id||id.length>256)||new Set(item.pendingVaultIds).size!==item.pendingVaultIds.length)
          throw fail('STICKER_IDENTITY','待清理贴纸的会话或目标仓库身份无效');
        const index=pending.findIndex(r=>(r as {stickerId:string}).stickerId===item.stickerId);
        if(index<0)throw fail('STICKER_IDENTITY','待清理贴纸已变化，请重新读取');
        const previous=pending[index] as {pendingVaultIds?:unknown};
        const previousTargets=previous.pendingVaultIds;
        if(Array.isArray(previousTargets)&&item.pendingVaultIds.some(id=>!previousTargets.includes(id)))
          throw fail('STICKER_IDENTITY','待清理操作不能改投新仓库');
        pending=pending.map((r,i)=>i===index?input.updateBacklinkDelete as never:r);
      }
      if(input.acknowledgeStickerId)pending=pending.filter(r=>(r as {stickerId:string}).stickerId!==input.acknowledgeStickerId);
      const saved=c.extensions.write({scope:c.scope,writerId:c.writerId,objectId:c.marker.objectId,expectedRevision:c.marker.revision,deleted:false,content:{...c.marker.content,body:jsonValueSchema.parse({...c.body,pendingBacklinkDeletes:pending})}});if(saved.status==='conflict')throw fail('REVISION_CONFLICT','贴纸清理记录冲突');
    });
    return this.legacyState(runId,input.document.sessionId);
  }
}
