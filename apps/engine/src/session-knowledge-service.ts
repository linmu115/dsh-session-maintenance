import { createHash } from 'node:crypto';
import {
  ExtensionDataError, knowledgeWriteSchema, knowledgeListSchema, knowledgeMigrationSchema, stickerMigrationSchema,
  networkQuerySchema, networkImpactSchema, type KnowledgeWrite, type KnowledgeList, type KnowledgeMigration,
  type ExtensionObject, type ExtensionWriteResult, type KnowledgePage, type NetworkPage, type NetworkImpact,
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
      await this.engine.sessionGraph.preview(runId,source.logicalSessionId,undefined,{sourceVersionId:source.sourceVersionId,sourceAnchorId:source.sourceAnchorId});
    }
    return extensions.write({scope,writerId,objectId:q.objectId,expectedRevision:q.expectedRevision,deleted:q.deleted,
      content:{schemaVersion:q.namespace==='obsidian-links'?2:1,title:q.title,body:jsonValueSchema.parse(JSON.parse(JSON.stringify(q.body))),references:[...new Set(refs)].map(logicalSessionId=>({logicalSessionId}))}});
  }
  async migration(runId:string,input:KnowledgeMigration) {
    const q=knowledgeMigrationSchema.parse(input),{scope,extensions,writerId}=await this.context(runId,'stickers');
    const identity=await this.engine.sessionGraph.resolve(runId,{nativeSessionId:q.nativeSessionId});
    const objectId='migration-'+hash(q.vaultId+'\0'+q.nativeSessionId).slice(0,40);
    let previous:ExtensionObject|undefined;
    try{previous=extensions.get(scope,objectId).object;}catch(e){if(!(e instanceof ExtensionDataError)||e.code!=='EXTENSION_NOT_FOUND')throw e;}
    if(previous){const old=stickerMigrationSchema.parse(previous.content.body);if(old.sourceDigest!==q.sourceDigest||old.migrationId!==q.migrationId||old.logicalSessionId!==identity.logicalSessionId)throw fail('MIGRATION_CONFLICT','旧对象与迁移回执不一致，请先解决冲突');if(old.phase==='active')return {object:previous,mappings:old.mappings};}
    if(new Set(q.stickers.map(s=>s.legacyId)).size!==q.stickers.length)throw fail('MIGRATION_CONFLICT','旧对象身份重复');
    const mappings=q.stickers.map(s=>({legacyId:s.legacyId,objectId:'legacy-'+hash(q.vaultId+'\0'+identity.logicalSessionId+'\0'+s.legacyId).slice(0,40)}));
    if(q.phase==='activate'&&!previous)throw fail('MIGRATION_NOT_STAGED','必须先完成导入与回执核对');
    return extensions.transaction(()=>{
      if(q.phase==='stage')for(let i=0;i<q.stickers.length;i++){
        const sticker=q.stickers[i]!,result=extensions.write({scope,writerId,objectId:mappings[i]!.objectId,expectedRevision:0,deleted:false,
          content:{schemaVersion:1,title:sticker.title||'贴纸',body:{kind:'annotation',logicalSessionId:identity.logicalSessionId,legacyStickerId:sticker.legacyId,record:sticker.record,migrationId:q.migrationId},references:[{logicalSessionId:identity.logicalSessionId}]}});
        if(result.status==='conflict')throw fail('MIGRATION_CONFLICT','迁移目标存在不同编辑，已保留旧写入冻结状态');
      }
      if(q.phase==='activate')for(let i=0;i<mappings.length;i++){
        const value=extensions.get(scope,mappings[i]!.objectId).object;
        if(stable((value.content.body as {record:unknown}).record)!==stable(q.stickers[i]!.record))throw fail('MIGRATION_VERIFY_FAILED','迁移对象核对失败');
      }
      const body={kind:'migration' as const,migrationId:q.migrationId,vaultId:q.vaultId,legacySessionId:q.nativeSessionId,logicalSessionId:identity.logicalSessionId,sourceDigest:q.sourceDigest,sourceRevision:q.sourceRevision,phase:q.phase==='stage'?'staged' as const:'active' as const,mappings,pendingBacklinkDeletes:q.pendingBacklinkDeletes};
      const saved=extensions.write({scope,writerId,objectId,expectedRevision:previous?.revision??0,deleted:false,content:{schemaVersion:1,title:'旧贴纸迁移',body,references:[{logicalSessionId:identity.logicalSessionId}]}});
      if(saved.status==='conflict')throw fail('MIGRATION_CONFLICT','迁移回执已改变');return {object:saved.object,mappings};
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
  async legacySave(runId:string,input:{document:{sessionId:string;stickers:unknown[]};expectedRevision:string;enqueueBacklinkDelete?:unknown;acknowledgeStickerId?:string|undefined}) {
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
      if(input.acknowledgeStickerId)pending=pending.filter(r=>(r as {stickerId:string}).stickerId!==input.acknowledgeStickerId);
      const saved=c.extensions.write({scope:c.scope,writerId:c.writerId,objectId:c.marker.objectId,expectedRevision:c.marker.revision,deleted:false,content:{...c.marker.content,body:{...c.body,pendingBacklinkDeletes:pending}}});if(saved.status==='conflict')throw fail('REVISION_CONFLICT','贴纸清理记录冲突');
    });
    return this.legacyState(runId,input.document.sessionId);
  }
  async network(runId:string,input:unknown):Promise<NetworkPage> {
    const q=networkQuerySchema.parse(input),{scope,extensions}=await this.context(runId),db=this.engine.repository.database;
    const ready = new Set(extensions.panels().filter(p => p.scope.instanceId === scope.instanceId && p.scope.profileId === scope.profileId && p.status === 'ready').map(p => p.scope.namespace));
    const rows=db.prepare(`WITH items AS (
      SELECT 'session:'||s.id key,'session' kind,s.display_title title,json_array(s.id) ids,NULL namespace,NULL objectId,NULL revision,0 deleted,0 conflicts,1 available
      FROM projection_sessions ps JOIN logical_sessions s ON s.id=ps.logical_session_id WHERE ps.run_id=? AND ${visible}
      UNION ALL
      SELECT o.namespace||':'||o.object_id key,CASE o.namespace WHEN 'thoughtdag' THEN 'canvas' WHEN 'stickers' THEN 'sticker' ELSE 'note' END kind,o.title,
        (SELECT json_group_array(json_extract(r.value,'$.logicalSessionId')) FROM json_each(o.content_json,'$.references') r) ids,
        o.namespace,o.object_id,o.revision,o.deleted,
        (SELECT count(*) FROM extension_conflicts c WHERE c.instance_id=o.instance_id AND c.profile_id=o.profile_id AND c.namespace=o.namespace AND c.object_id=o.object_id),
        COALESCE((SELECT configured*enabled FROM extension_connections c WHERE c.instance_id=o.instance_id AND c.profile_id=o.profile_id AND c.namespace=o.namespace),0)
      FROM extension_objects o WHERE o.instance_id=? AND o.profile_id=? AND o.namespace IN ('thoughtdag','stickers','obsidian-links')
      AND COALESCE(json_extract(o.content_json,'$.body.kind'),'')!='migration'
      AND ${activeImport}
      AND NOT EXISTS(SELECT 1 FROM json_each(o.content_json,'$.references') r WHERE NOT EXISTS(SELECT 1 FROM projection_sessions ps JOIN logical_sessions s ON s.id=ps.logical_session_id WHERE ps.run_id=? AND ${visible} AND ps.logical_session_id=json_extract(r.value,'$.logicalSessionId')))
    ) SELECT * FROM items WHERE key>? AND (?='all' OR kind=?) AND (?=1 OR deleted=0) AND instr(lower(title),lower(?))>0 ORDER BY key LIMIT 51`)
      .all(runId,scope.instanceId,scope.profileId,runId,q.after??'',q.kind,q.kind,q.includeDeleted?1:0,q.query) as unknown as Array<{key:string;kind:'session'|'canvas'|'sticker'|'note';title:string;ids:string;namespace:string|null;objectId:string|null;revision:number|null;deleted:number;conflicts:number;available:number}>;
    return {items:rows.slice(0,50).map(r=>({key:r.key,kind:r.kind,title:r.title.slice(0,500),logicalSessionIds:JSON.parse(r.ids),...(r.namespace?{namespace:r.namespace,objectId:r.objectId!,revision:r.revision!}:{}),deleted:!!r.deleted,conflicts:r.conflicts,available:r.kind==='session'||ready.has(r.namespace!)})),nextCursor:rows.length>50?rows[49]!.key:null};
  }
  async impact(runId:string,input:unknown):Promise<NetworkImpact> {
    const q=networkImpactSchema.parse(input),{scope}=await this.context(runId);
    await this.engine.sessionGraph.resolve(runId,{logicalSessionId:q.logicalSessionId});
    const db=this.engine.repository.database,result:NetworkImpact={sourceLogicalSessionId:q.logicalSessionId,visited:1,truncated:false,items:[]};
    let frontier=[q.logicalSessionId];const visited=new Set(frontier);
    for(let depth=1;depth<=q.depth&&frontier.length;depth++){
      const next:string[]=[];
      for(const sourceId of frontier){
        const rows=db.prepare(`SELECT json_extract(o.content_json,'$.body.referenceId') referenceId,json_extract(o.content_json,'$.body.sourceSessionId') sourceSessionId,
          json_extract(o.content_json,'$.body.targetSessionId') targetSessionId,json_extract(o.content_json,'$.body.sourceVersionId') sourceVersionId,
          json_extract(o.content_json,'$.body.sourceAnchorId') sourceAnchorId,s.head_version_id currentSourceVersionId,t.display_title title,
          EXISTS(SELECT 1 FROM session_versions v WHERE v.id=json_extract(o.content_json,'$.body.sourceVersionId')) versionExists
          FROM extension_objects o LEFT JOIN logical_sessions s ON s.id=json_extract(o.content_json,'$.body.sourceSessionId') AND s.tombstoned_at IS NULL
          JOIN logical_sessions t ON t.id=json_extract(o.content_json,'$.body.targetSessionId')
          WHERE o.instance_id=? AND o.profile_id=? AND o.namespace='annotation-upstream' AND o.deleted=0 AND json_extract(o.content_json,'$.body.state')='sent'
          AND json_extract(o.content_json,'$.body.sourceSessionId')=?
          AND EXISTS(SELECT 1 FROM projection_sessions ps WHERE ps.run_id=? AND ps.logical_session_id=t.id AND ps.mode NOT IN ('hidden','recovery-only')) AND t.tombstoned_at IS NULL
          ORDER BY o.object_id LIMIT 201`).all(scope.instanceId,scope.profileId,sourceId,runId) as unknown as Array<Omit<NetworkImpact['items'][number],'status'|'depth'>&{versionExists:number}>;
        for(const r of rows){if(result.items.length>=200){result.truncated=true;break;}const {versionExists,...row}=r;result.items.push({...row,title:row.title.slice(0,500),status:!versionExists||!row.currentSourceVersionId?'source-unavailable':row.currentSourceVersionId!==row.sourceVersionId?'new-content':'fixed',depth});if(!visited.has(row.targetSessionId)){visited.add(row.targetSessionId);next.push(row.targetSessionId);}}
        if(result.truncated)break;
      }
      frontier=next;if(result.truncated)break;
    }
    if(frontier.length)result.truncated=true;result.visited=visited.size;return result;
  }
}
