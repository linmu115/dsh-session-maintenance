import { createHash, randomUUID } from "node:crypto";
import { ExtensionDataError, SESSION_CONTEXT_NAMESPACE, sessionContextCaptureSchema, sessionContextReadSchema,
  sessionContextRecordSchema, type SessionContextCapture, type SessionContextRecord, type SessionContextRead,
  type SessionContextDirectory, type LogicalSessionId, type SessionVersionId, type NativeSessionId, type RunId, type JsonValue, type AdapterId } from "@linmu/dsh-session-contracts";
import { JsonProjectionDirectory, projectionRootFor } from "@linmu/dsh-session-projection-lifecycle";
import type { SessionMaintenanceEngine } from "./engine.js";
import { ContextReadBudgets, readContextPage, contextContinuationPosition } from "./session-context-reader.js";

const unavailable = (message: string) => new ExtensionDataError("CONTEXT_UNAVAILABLE",message,409);
export class SessionContextService {
  private budgetStore?: ContextReadBudgets;
  private get budgets(){return this.budgetStore??=new ContextReadBudgets(this.engine.repository.database);}
  constructor(private readonly engine: SessionMaintenanceEngine) {}
  private async access(runId: string) {
    const run = await this.engine.projectionRunRepository.getProjectionRun(runId as RunId);
    if (!run || run.state !== "running") throw unavailable("目标实例的会话空间尚未就绪");
    const panel = this.engine.extensions?.panels().find(p=>p.scope.instanceId===run.instanceId&&p.scope.profileId===run.profileId&&p.scope.namespace===SESSION_CONTEXT_NAMESPACE);
    if (!panel) throw unavailable("当前实例尚未配置跨会话引用");
    if (panel.status === "incompatible") throw unavailable(`跨会话引用版本不兼容（Annotation Core ${panel.pluginVersion}），请更新匹配的 Maintenance 扩展适配器`);
    if (panel.status === "missing-adapter") throw unavailable("当前 Maintenance 缺少跨会话引用扩展适配器");
    if (panel.status !== "ready") throw unavailable("当前实例的跨会话引用已停用");
    return { run, scope:panel.scope, writerId:panel.writerId, extensions:this.engine.extensions! };
  }
  private identity(runId: string, nativeSessionId: string) {
    const value = this.engine.sessionQueries.resolveProjectionSessionIdentity(runId,nativeSessionId);
    if (!value || value.status !== "active") throw unavailable("会话未接入当前实例，或已删除");
    const mapping=this.engine.repository.database.prepare("SELECT mode FROM projection_sessions WHERE run_id=? AND native_session_id=?").get(runId,nativeSessionId) as {mode:string}|undefined;
    if(!mapping||["hidden","recovery-only"].includes(mapping.mode))throw unavailable("会话没有在当前实例中启用");
    return value;
  }
  async directory(runId: string, workspaceId?: string, after = ""): Promise<SessionContextDirectory> {
    await this.access(runId);
    const db = this.engine.repository.database;
    const join = `FROM projection_sessions ps JOIN logical_sessions s ON s.id=ps.logical_session_id
      LEFT JOIN project_memberships m ON m.logical_session_id=s.id LEFT JOIN logical_projects w ON w.id=m.project_id AND w.deleted_at IS NULL
      WHERE ps.run_id=? AND ps.mode NOT IN ('hidden','recovery-only') AND s.tombstoned_at IS NULL`;
    const rows = workspaceId === undefined
      ? db.prepare(`SELECT DISTINCT COALESCE(w.id,'@ungrouped') id,COALESCE(w.name,'未分组') title ${join}
          AND COALESCE(w.id,'@ungrouped')>? ORDER BY id LIMIT 51`).all(runId,after)
      : db.prepare(`SELECT ps.native_session_id id,s.display_title title,s.id logicalSessionId ${join}
          AND COALESCE(w.id,'@ungrouped')=? AND ps.native_session_id>? ORDER BY id LIMIT 51`).all(runId,workspaceId,after);
    const items = rows as unknown as SessionContextDirectory["items"];
    return { items:items.slice(0,50),nextCursor:items.length>50?items[49]!.id:null };
  }
  async capture(request: SessionContextCapture): Promise<SessionContextRecord> {
    const input=sessionContextCaptureSchema.parse(request), a=await this.access(input.runId);
    const source=this.identity(input.runId,input.sourceNativeSessionId), target=this.identity(input.runId,input.targetNativeSessionId);
    if (source.logicalSessionId===target.logicalSessionId) throw unavailable("跨会话引用请选择另一个会话");
    const referenceId="upstream-"+createHash("sha256").update(JSON.stringify([a.scope,target.logicalSessionId,input.operationId])).digest("hex");
    try {
      const old=sessionContextRecordSchema.parse(a.extensions.get(a.scope,referenceId).object.content.body);
      if (input.expectedSourceVersionId && old.sourceVersionId !== input.expectedSourceVersionId)
        throw unavailable("同一引用操作的来源版本与所选材料不一致，请重新选择回复");
      if (old.sourceSessionId!==source.logicalSessionId || old.sourceAnchorId!==input.anchorId || old.selectedText!==input.selectedText)
        throw unavailable("同一引用操作的来源发生变化");
      if(old.state==="revoked")throw unavailable("这个引用操作已撤销，请重新选择来源");
      await this.engine.sessionGraph.syncReference(input.runId, old);
      return old;
    } catch (error) { if (!(error instanceof ExtensionDataError) || error.code!=="EXTENSION_NOT_FOUND") throw error; }
    const snapshot=await this.engine.canonicalEngine.store.getSession(source.logicalSessionId as LogicalSessionId);
    const version=snapshot?.headVersionId?await this.engine.canonicalEngine.store.getVersion(snapshot.headVersionId):undefined;
    if (!version) throw unavailable("来源回复尚未登记到会话真源，请稍后重试");
    if (input.expectedSourceVersionId && version.id !== input.expectedSourceVersionId)
      throw unavailable("来源版本已改变，请重新选择回复；未创建引用");
    const adapter=this.engine.resolveProjectionAdapter(a.run.adapterId)?.sessionContext;
    if (!adapter) throw unavailable("当前 DSH 版本 Adapter 尚未支持固定上游引用");
    const payload=await new JsonProjectionDirectory(projectionRootFor(this.engine.projectionRuntimeRoot,a.run.id)).readSession(input.sourceNativeSessionId as NativeSessionId);
    const restored=await this.engine.projectionSourceFor(a.run.adapterId).loadVersionEvents?.(source.logicalSessionId as LogicalSessionId,version.id);
    if(!restored)throw unavailable("来源版本缺少可验证的格式读取能力");
    let cutoff;
    try {cutoff=adapter.cutoff(restored,payload,input.anchorId);}
    catch(error){throw unavailable(error instanceof Error?error.message:"无法定位来源完成位置");}
    const originalCutoff=version.events.find(event=>event.id===cutoff.eventId);
    if(!originalCutoff)throw unavailable("来源格式读取改变了原始完成位置身份");
    if (input.expectedSourceVersionId) {
      const latest = await this.engine.canonicalEngine.store.getSession(source.logicalSessionId as LogicalSessionId);
      if (latest?.headVersionId !== input.expectedSourceVersionId)
        throw unavailable("来源在捕获期间已改变，请重新选择回复；未创建引用");
    }
    const record: SessionContextRecord={schemaVersion:1,referenceId,sourceSessionId:source.logicalSessionId,sourceVersionId:version.id,
      cutoffEventId:cutoff.eventId,cutoffDigest:originalCutoff.contentDigest,targetSessionId:target.logicalSessionId,selectedText:input.selectedText,
      sourceTitle:source.title.slice(0,500),sourceAnchorId:input.anchorId,state:"pending",targetMessageId:null,createdAt:new Date().toISOString()};
    const result=a.extensions.write({scope:a.scope,writerId:a.writerId,objectId:referenceId,expectedRevision:0,deleted:false,
      content:{schemaVersion:1,title:record.sourceTitle,body:record as unknown as JsonValue,references:[
        {logicalSessionId:record.sourceSessionId,messageId:record.cutoffEventId,sourceVersion:record.sourceVersionId},
        {logicalSessionId:record.targetSessionId}]}});
    if(result.status==="conflict")throw unavailable("引用保存冲突，请重试");
    await this.engine.sessionGraph.syncReference(input.runId, record);
    return record;
  }
  async record(runId: string, targetNativeSessionId: string, referenceId: string, allowRevoked = false) {
    const a=await this.access(runId), target=this.identity(runId,targetNativeSessionId);
    const object=a.extensions.get(a.scope,referenceId).object,record=sessionContextRecordSchema.parse(object.content.body);
    if(object.deleted||(!allowRevoked&&record.state==="revoked")||record.targetSessionId!==target.logicalSessionId)throw unavailable("此引用在目标会话中不可用");
    return {...a,object,record};
  }
  async bind(runId: string, targetNativeSessionId: string, referenceId: string, targetMessageId: string | null) {
    const a=await this.record(runId,targetNativeSessionId,referenceId,targetMessageId===null);
    if ((a.record.state==="revoked"&&targetMessageId===null) || (a.record.state==="sent"&&targetMessageId===a.record.targetMessageId)) {
      await this.engine.sessionGraph.syncReference(runId, a.record);
      return a.record;
    }
    if (a.record.targetMessageId && targetMessageId && a.record.targetMessageId!==targetMessageId) throw unavailable("引用已经绑定另一次提交");
    const record={...a.record,state:targetMessageId?"sent" as const:"revoked" as const,targetMessageId};
    const result=a.extensions.write({scope:a.scope,writerId:a.writerId,objectId:referenceId,expectedRevision:a.object.revision,deleted:false,
      content:{...a.object.content,body:record as unknown as JsonValue}});
    if(result.status==="conflict")throw unavailable("引用状态保存冲突，请重试");
    await this.engine.sessionGraph.syncReference(runId, record);
    return record;
  }
  private async source(record: SessionContextRecord, adapterId: AdapterId) {
    try {
      const source=await this.engine.canonicalEngine.store.getSession(record.sourceSessionId as LogicalSessionId);
      if(!source||source.session.tombstonedAt)throw unavailable("来源会话已删除");
      const version=await this.engine.canonicalEngine.store.getVersion(record.sourceVersionId as SessionVersionId);
      if(!version||version.logicalSessionId!==record.sourceSessionId)throw unavailable("来源版本已清理或不可用");
      const index=version.events.findIndex(e=>e.id===record.cutoffEventId&&e.contentDigest===record.cutoffDigest);
      if(index<0)throw unavailable("来源完成位置已不可解析");
      const events=await this.engine.projectionSourceFor(adapterId).loadVersionEvents?.(record.sourceSessionId as LogicalSessionId,record.sourceVersionId as SessionVersionId);
      if(!events||events.length!==version.events.length||events.some((e,i)=>e.id!==version.events[i]!.id))throw unavailable("来源格式读取改变了原始事件身份");
      return {events,index};
    } catch(error) {
      if(error instanceof ExtensionDataError)throw error;
      throw unavailable("来源版本已清理或不可用，无法读取固定上游");
    }
  }
  async inspect(runId: string, targetNativeSessionId: string, referenceId: string) {
    const a=await this.record(runId,targetNativeSessionId,referenceId);
    await this.source(a.record,a.run.adapterId);
    return a.record;
  }
  async describe(runId: string, targetNativeSessionId: string, referenceId: string) {
    const record = await this.inspect(runId, targetNativeSessionId, referenceId);
    const source = await this.engine.sessionGraph.resolve(runId, { logicalSessionId: record.sourceSessionId });
    return { record, sourceNativeSessionId: source.nativeSessionId };
  }
  async settleRead(runId: string, targetNativeSessionId: string, referenceId: string, requestId: string, delivery: 'returned' | 'failed') {
    const a = await this.record(runId, targetNativeSessionId, referenceId, true);
    const receipt = await this.engine.sessionGraph.settleDisclosure(runId, a.record, requestId,
      a.record.state === 'revoked' ? 'failed' : delivery);
    if (a.record.state === 'revoked' && delivery === 'returned') throw unavailable('引用在读取期间已撤销');
    return receipt;
  }
  async read(request: SessionContextRead) {
    const q=sessionContextReadSchema.parse(request),a=await this.record(q.runId,q.targetNativeSessionId,q.referenceId);
    this.budgets.cleanup();
    let reservation:ReturnType<ContextReadBudgets['reserve']>;
    try{reservation=this.budgets.reserve(JSON.stringify([a.run.id,a.record.targetSessionId,q.executionId]),q.totalBytes,q.maxBytes,a.run.id);}
    catch(error){throw unavailable(error instanceof Error?error.message:'本轮引用读取不可用');}
    if(reservation.bytes<1024){reservation.settle(0);throw unavailable("本轮引用读取预算已用完，请依据已读取材料回答");}
    let settled=false;
    try {
      const {events,index}=await this.source(a.record,a.run.adapterId);
      const adapter=this.engine.resolveProjectionAdapter(a.run.adapterId)?.sessionContext;
      if(!adapter)throw unavailable("缺少读取此引用所需的版本 Adapter");
      let page;
      const fixed = events.slice(0,index+1), entries = adapter.entries(fixed);
      try {
        if (q.view && (q.cursor || q.query)) throw new Error("首轮上下文不能同时指定游标或搜索词");
        page=readContextPage(a.record,entries,reservation.bytes,q.cursor,q.query,
          q.view === "selected-turn" ? adapter.selectedTurnStart(fixed) : undefined,
          q.view === "selected-turn" ? adapter.selectedReply(fixed) : undefined);
      }
      catch(error){throw unavailable(error instanceof Error?error.message:"引用读取失败");}
      // A revoke may have been serialized while the immutable source was being read.
      await this.record(q.runId,q.targetNativeSessionId,q.referenceId);
      // Reserve enough space for remainingBytes digits; the complete serialized return is charged.
      page.remainingBytes=Math.max(0,q.totalBytes);const bytes=Buffer.byteLength(JSON.stringify(page));
      settled=true;page.remainingBytes=reservation.settle(bytes);
      page.budgetExhausted=page.remainingBytes<1024;
      await this.engine.sessionGraph.appendDisclosure(q.runId, a.record, {
        requestId: q.requestId ?? randomUUID(), executionId: q.executionId,
        operation: q.view === 'selected-turn' ? 'initial' : q.query ? 'search' : 'read', delivery: 'prepared',
        ranges: page.items.map(item => ({eventId:item.eventId,start:item.offset,end:item.offset+item.text.length,complete:item.complete})),
        nextCursor:page.nextCursor,next:contextContinuationPosition(entries,page.nextCursor),hasMore:page.hasMore,
        truncated:page.hasMore || page.items.some(item=>!item.complete) || Boolean(page.selectedTurn?.omittedIntermediateItems),
        returnedBytes:bytes, remainingBytes:page.remainingBytes,
        ...(page.selectedTurn ? {selectedTurnComplete:page.selectedTurn.complete} : {}),
        status:page.budgetExhausted?'budget-exhausted':page.items.length?'ok':'empty',
      });
      await this.record(q.runId,q.targetNativeSessionId,q.referenceId);
      return page;
    } finally {if(!settled)try{reservation.settle(0);}catch{/* A completed execution already discarded this reservation. */}}
  }
  async endExecution(runId:string,targetNativeSessionId:string,executionId:string){
    const a=await this.access(runId),target=this.identity(runId,targetNativeSessionId);
    this.budgets.end(JSON.stringify([a.run.id,target.logicalSessionId,executionId]),a.run.id);
    this.budgets.cleanup();return {ended:true};
  }
  cleanupExecutions(){this.budgets.cleanup();}
}
