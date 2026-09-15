import { createHash } from "node:crypto";
import { SqliteExtensionRepository } from "@linmu/dsh-session-store";
import { JsonProjectionDirectory, projectionRootFor } from "@linmu/dsh-session-projection-lifecycle";
import { verifyV3NativeContextMaterials, verifyV3NativeContextRelease } from "@linmu/dsh-session-adapter-0-1-5";
import {
  ExtensionDataError, NATIVE_CONTEXT_NAMESPACE, nativeContextStateSchema, nativeContextScopeSchema,
  nativeContextWindowSchema, nativeContextSourceSetSchema, nativeContextReleaseSchema, nativeContextPinSchema,
  nativeContextRegisterSchema, nativeContextReceiptSchema, nativeContextGraphEditSchema, sessionContextRecordSchema,
  type NativeContextScope, type NativeContextState, type NativeContextDocument, type NativeContextSource,
  type NativeContextMaterial, type NativeContextOperation, type NativeContextRange, type NativeContextReleasePlans,
  type RunId, type NativeSessionId, type ExtensionScope, type JsonValue, type SessionContextEntry, type SessionContextRecord,
} from "@linmu/dsh-session-contracts";
import type { SessionMaintenanceEngine } from "./engine.js";
import { graphObjectId } from "./session-graph-store.js";
import { ContextReadBudgets } from "./session-context-reader.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (message: string, code = "NATIVE_CONTEXT_CONFLICT") => new ExtensionDataError(code, message, 409);
const objectIdFor = (owner: string) => `context-${hash(owner)}`;
const materialInput=(material:NativeContextMaterial)=>({materialId:material.materialId,eventSeq:material.eventSeq,referenceIds:material.referenceIds,
  kind:material.kind,bytes:material.bytes,contentHash:material.contentHash,ranges:material.ranges,
  ...(material.sourceEventSeqs?{sourceEventSeqs:material.sourceEventSeqs}:{})});
const empty = (ownerSessionId: string): NativeContextState => ({ schemaVersion: 1, kind: "native-context", ownerSessionId,
  sources: [], materials: [], operations: [], trimmedMaterials: 0, trimmedOperations: 0, retiredThroughSeq: -1 });

/** Shared business state only. Native surface interpretation/application belongs to the DSH Host/Adapter. */
export class NativeContextService {
  private repository?: SqliteExtensionRepository;
  private get store() { return this.repository ??= new SqliteExtensionRepository(this.engine.repository.database); }
  constructor(private readonly engine: SessionMaintenanceEngine) {}
  async metadataRead<T>(scope: NativeContextScope, maxBytes: number, totalBytes: number, read:()=>Promise<T>) {
    const a=await this.access(scope.runId,scope.targetNativeSessionId),budgets=new ContextReadBudgets(this.engine.repository.database);
    const reservation=budgets.reserve(JSON.stringify([scope.runId,a.identity.logicalSessionId,scope.executionId]),totalBytes,maxBytes,scope.runId);
    let settled=false;
    try{if(reservation.bytes<maxBytes)throw fail("本轮剩余额度不足以返回此元数据页，请先依据已有内容处理", "NATIVE_CONTEXT_BUDGET_EXHAUSTED");
      const result=await read();const remaining=reservation.settle(maxBytes);settled=true;
      return {...result,readBudgetRemainingBytes:remaining};
    }finally{if(!settled)reservation.settle(0);}
  }
  async configured(runId: string) {
    const run = await this.engine.projectionRunRepository.getProjectionRun(runId as RunId);
    return run ? this.engine.extensions?.panels().some(p => p.scope.instanceId === run.instanceId && p.scope.profileId === run.profileId
      && p.scope.namespace === NATIVE_CONTEXT_NAMESPACE && p.status === "ready") ?? false : false;
  }
  private async access(runId: string, nativeSessionId: string) {
    const identity = await this.engine.sessionGraph.resolve(runId, { nativeSessionId });
    const run = await this.engine.projectionRunRepository.getProjectionRun(runId as RunId);
    if (!run || run.state !== "running") throw fail("原生上下文运行尚未就绪");
    const panel = this.engine.extensions?.panels().find(p => p.scope.instanceId === run.instanceId && p.scope.profileId === run.profileId
      && p.scope.namespace === NATIVE_CONTEXT_NAMESPACE);
    if (!panel || panel.status !== "ready") throw fail("当前实例未启用匹配的原生上下文管理能力", "NATIVE_CONTEXT_UNSUPPORTED");
    const objectId = objectIdFor(identity.logicalSessionId), object = this.store.get(panel.scope, objectId);
    if (object?.deleted) throw fail("上下文状态已停用，不能自动恢复");
    const state = object ? nativeContextStateSchema.parse(object.content.body) : empty(identity.logicalSessionId);
    if (state.ownerSessionId !== identity.logicalSessionId) throw fail("上下文状态不属于当前会话");
    return { identity, run, scope: panel.scope, writerId: panel.writerId, objectId, revision: object?.revision ?? 0, state };
  }
  private save(a: Awaited<ReturnType<NativeContextService["access"]>>, state: NativeContextState) {
    while (state.operations.length > 128) {
      const i = state.operations.findIndex(op => op.state !== "pending-next-step");
      if (i < 0) throw fail("待处理上下文操作过多，请先完成已有操作");
      state.operations.splice(i, 1); state.trimmedOperations++;
    }
    while (state.materials.length > 256) {
      const released = state.materials.filter(m => m.state === "released").sort((x, y) => x.eventSeq - y.eventSeq)[0];
      if (!released) throw fail("保留材料达到上限，请先释放已用材料");
      state.materials = state.materials.filter(m => m.materialId !== released.materialId);
      state.retiredThroughSeq = Math.max(state.retiredThroughSeq, released.eventSeq); state.trimmedMaterials++;
    }
    nativeContextStateSchema.parse(state);
    if (Buffer.byteLength(JSON.stringify(state)) > 262144) throw fail("上下文结构达到容量上限，请先处理已有材料");
    const result = this.store.write({ scope: a.scope, writerId: a.writerId, objectId: a.objectId, expectedRevision: a.revision,
      deleted: false, content: { schemaVersion: 1, title: "上下文管理", body: state as unknown as JsonValue,
        references: [{ logicalSessionId: state.ownerSessionId }] } });
    if (result.status === "conflict") throw fail("上下文状态已变化，请刷新后重试");
    return result.object.revision;
  }
  private refs(scope: ExtensionScope, owner: string): SessionContextRecord[] {
    const rows = this.engine.repository.database.prepare(`SELECT content_json FROM extension_objects
      WHERE instance_id=? AND profile_id=? AND namespace='annotation-upstream'
      AND json_extract(content_json,'$.body.targetSessionId')=? ORDER BY object_id LIMIT 257`)
      .all(scope.instanceId, scope.profileId, owner);
    if (rows.length > 256) throw fail("本会话来源超过管理上限，请先整理引用");
    return rows.flatMap(row => { const result = sessionContextRecordSchema.safeParse(JSON.parse(row.content_json as string).body); return result.success ? [result.data] : []; });
  }
  private mergeSources(state: NativeContextState, records: SessionContextRecord[]) {
    const existing = new Map(state.sources.map(source => [source.referenceId, source]));
    for (const record of records) {
      const old = existing.get(record.referenceId);
      const source: NativeContextSource = { referenceId: record.referenceId, sourceSessionId: record.sourceSessionId,
        sourceVersionId: record.sourceVersionId, cutoffEventId: record.cutoffEventId, title: record.sourceTitle,
        enabled: old?.enabled ?? true, window: old?.window ?? null, generation: old?.generation ?? 0,
        authorityState: record.state, ...(old?.activation ? { activation: old.activation } : {}) };
      const unavailable = this.engine.repository.database.prepare(`SELECT 1 FROM logical_sessions WHERE id=?
        AND (tombstoned_at IS NOT NULL OR archived_at IS NOT NULL OR archived=1)`).get(record.sourceSessionId);
      const version=this.engine.repository.database.prepare("SELECT 1 FROM session_versions WHERE id=? AND logical_session_id=?").get(record.sourceVersionId,record.sourceSessionId);
      if (unavailable || !version) source.authorityState = "unavailable";
      existing.set(record.referenceId, source);
    }
    const ids = new Set(records.map(r => r.referenceId));
    for (const source of existing.values()) if (!ids.has(source.referenceId)) source.authorityState = "unavailable";
    state.sources = [...existing.values()];
  }
  async status(scope: NativeContextScope, includeGraph = false): Promise<NativeContextDocument> {
    const {runId,targetNativeSessionId,actor,executionId}=scope;
    const q = nativeContextScopeSchema.parse({runId,targetNativeSessionId,actor,executionId}), a = await this.access(q.runId, q.targetNativeSessionId);
    this.mergeSources(a.state, this.refs(a.scope, a.identity.logicalSessionId));
    const document: NativeContextDocument = { ...a.state, protocolVersion: 1, objectId: a.objectId,
      revision: a.revision, nativeSessionId: q.targetNativeSessionId };
    {
      try { const graph = await this.engine.sessionGraph.load(q.runId, graphObjectId(a.identity.logicalSessionId));
        if(includeGraph)document.graph=graph;
        const history=await this.engine.sessionGraph.disclosures(q.runId,graph.objectId);
        document.coverage=history.coverage;document.coverageTruncated=history.coverageTruncated;
        document.coverageRevision=hash([history.coverage,history.trimmedCount]);
      }
      catch (error) { if (!(error instanceof ExtensionDataError)) throw error; }
    }
    return document;
  }
  async assertReferenceReadable(runId: string, nativeSessionId: string, referenceId: string) {
    if (!await this.configured(runId)) {
      const run=await this.engine.projectionRunRepository.getProjectionRun(runId as RunId);
      if(run&&this.engine.extensions?.panels().some(p=>p.scope.instanceId===run.instanceId&&p.scope.profileId===run.profileId&&p.scope.namespace===NATIVE_CONTEXT_NAMESPACE))
        throw fail("原生上下文能力已停用或不兼容，不能绕过已保存的披露限制", "NATIVE_CONTEXT_UNSUPPORTED");
      return { revision: 0, window: null as NativeContextRange[] | null };
    }
    const a = await this.access(runId, nativeSessionId), source = a.state.sources.find(s => s.referenceId === referenceId);
    if (source && !source.enabled) throw fail("来源已暂停，请先恢复该连接", "NATIVE_CONTEXT_PAUSED");
    return { revision: source?.generation ?? 0, window: source?.window ?? null };
  }
  async allowedEntries(runId: string, nativeSessionId: string, referenceId: string, entries: readonly SessionContextEntry[], eventIds: readonly string[] = entries.map(entry=>entry.eventId)) {
    const policy = await this.assertReferenceReadable(runId, nativeSessionId, referenceId);
    const positions=new Map(eventIds.map((id,index)=>[id,index]));
    return { ...policy, entries: policy.window === null ? entries : entries.filter(entry =>
      policy.window!.some(range => { const start=positions.get(range.startEventId),end=positions.get(range.endEventId),index=positions.get(entry.eventId);
        return start!==undefined&&end!==undefined&&index!==undefined&&end>=start&&index>=start&&index<=end; })) };
  }
  private begin(a: Awaited<ReturnType<NativeContextService["access"]>>, q: NativeContextScope & {operationId:string; expectedRevision:number; reason:string}, action: string, payload: unknown) {
    const digest = hash([action, q.actor, q.executionId, payload]);
    const old = a.state.operations.find(op => op.operationId === q.operationId);
    if (old) { if (old.digest !== digest) throw fail("同一操作身份不能用于不同的上下文修改"); return { old, digest }; }
    if (a.revision !== q.expectedRevision) throw fail(`上下文状态已变化（currentRevision=${a.revision}），请重新核对操作范围后重试`);
    this.mergeSources(a.state, this.refs(a.scope, a.identity.logicalSessionId));
    return { old: undefined, digest };
  }
  private operation(q: NativeContextScope & {operationId:string;reason:string}, digest:string, action:string, materialIds:string[]): NativeContextOperation {
    return { operationId:q.operationId,digest,action,actor:q.actor,executionId:q.executionId,
      state:materialIds.length ? "pending-next-step" : "applied", materialIds,reason:q.reason,createdAt:new Date().toISOString() };
  }
  private releaseMaterials(state: NativeContextState, materials: NativeContextMaterial[], actor: NativeContextScope["actor"], revoke = false, referenceId?: string) {
    const releasable = materials.filter(m => !referenceId || m.referenceIds.every(id => id === referenceId || m.releasedReferenceIds.includes(id)));
    if (!revoke && actor === "model" && releasable.some(m => m.pinnedByUser)) throw fail("这些材料由用户固定保留，请选择其它材料");
    const ids: string[] = [];
    for (const material of materials) {
      material.releasedReferenceIds = [...new Set([...material.releasedReferenceIds, ...(referenceId ? [referenceId] : material.referenceIds)])];
      if (material.state !== "released" && releasable.includes(material)) { material.state = "release-pending"; ids.push(material.materialId); }
    }
    return ids;
  }
  private async sourceState(a: Awaited<ReturnType<NativeContextService["access"]>>, runId:string, nativeSessionId:string, referenceId:string) {
    const record = (await this.engine.sessionContext.record(runId, nativeSessionId, referenceId)).record;
    this.mergeSources(a.state, [ ...this.refs(a.scope, a.identity.logicalSessionId) ]);
    return { record, source: a.state.sources.find(s => s.referenceId === record.referenceId)! };
  }
  async windowSet(input: unknown) {
    const q = nativeContextWindowSchema.parse(input), a = await this.access(q.runId,q.targetNativeSessionId);
    const begun = this.begin(a,q,"window-set",[q.referenceId,q.ranges]);
    if (begun.old) return this.status(q);
    const {record,source} = await this.sourceState(a,q.runId,q.targetNativeSessionId,q.referenceId);
    const fixed = await this.engine.sessionContext.source(record,a.run.adapterId);
    const positions = new Map(fixed.events.slice(0,fixed.index+1).map((entry,index)=>[entry.id,index]));
    for (const range of q.ranges ?? []) {
      const start=positions.get(range.startEventId),end=positions.get(range.endEventId);
      if (start === undefined || end === undefined || start>end) throw fail("窗口位置不在该引用的固定授权范围内");
    }
    const outside = a.state.materials.filter(m=>m.referenceIds.includes(q.referenceId) && m.state!=="released" &&
      (q.ranges !== null && (q.ranges.length===0 || m.ranges.some(range=>range.referenceId===q.referenceId &&
        !q.ranges!.some(allowed=> { const index=positions.get(range.eventId);return index!==undefined && index>=positions.get(allowed.startEventId)! && index<=positions.get(allowed.endEventId)!; })))));
    const materialIds=this.releaseMaterials(a.state,outside,q.actor,false,q.referenceId);
    source.window=q.ranges;source.generation++;
    a.state.operations.push(this.operation(q,begun.digest,"window-set",materialIds));this.save(a,a.state);
    return this.status(q);
  }
  async sourceSet(input: unknown) {
    const q=nativeContextSourceSetSchema.parse(input),a=await this.access(q.runId,q.targetNativeSessionId),begun=this.begin(a,q,"source-set",[q.referenceId,q.enabled,q.release]);
    if(begun.old)return this.status(q);
    const {source}=await this.sourceState(a,q.runId,q.targetNativeSessionId,q.referenceId);
    const materialIds=q.release?this.releaseMaterials(a.state,a.state.materials.filter(m=>m.referenceIds.includes(q.referenceId)),q.actor,false,q.referenceId):[];
    source.enabled=q.enabled;source.generation++;
    a.state.operations.push(this.operation(q,begun.digest,"source-set",materialIds));this.save(a,a.state);return this.status(q);
  }
  async release(input: unknown) {
    const q=nativeContextReleaseSchema.parse(input),a=await this.access(q.runId,q.targetNativeSessionId),begun=this.begin(a,q,"release",[q.referenceId,q.materialIds]);
    if(begun.old)return this.status(q);
    const materials=a.state.materials.filter(m=>q.referenceId ? m.referenceIds.includes(q.referenceId) : q.materialIds!.includes(m.materialId));
    if(q.materialIds?.some(id=>!materials.some(m=>m.materialId===id)))throw fail("材料不属于当前会话或已被裁剪，请刷新状态");
    const ids=this.releaseMaterials(a.state,materials,q.actor,false,q.referenceId);
    a.state.operations.push(this.operation(q,begun.digest,"release",ids));this.save(a,a.state);return this.status(q);
  }
  async pin(input: unknown) {
    const q=nativeContextPinSchema.parse(input),a=await this.access(q.runId,q.targetNativeSessionId),begun=this.begin(a,q,"pin",[q.materialIds,q.pinned]);
    if(begun.old)return this.status(q);
    for(const id of q.materialIds){const material=a.state.materials.find(m=>m.materialId===id);if(!material||material.state!=="retained")throw fail("只有当前保留材料可以设置保留标记");
      if(q.actor==="user")material.pinnedByUser=q.pinned;else material.pinnedByModel=q.pinned;}
    a.state.operations.push(this.operation(q,begun.digest,"pin",[]));this.save(a,a.state);return this.status(q);
  }
  async registerMaterials(input: unknown) {
    const q=nativeContextRegisterSchema.parse(input);if(q.actor!=="host")throw fail("材料登记仅供原生宿主使用");
    const a=await this.access(q.runId,q.targetNativeSessionId);let changed=false;
    const payload=await new JsonProjectionDirectory(projectionRootFor(this.engine.projectionRuntimeRoot,a.run.id)).readSession(q.targetNativeSessionId as NativeSessionId);
    try{verifyV3NativeContextMaterials(payload,{nativeSessionId:q.targetNativeSessionId,materials:q.materials});}
    catch(error){throw fail(error instanceof Error?error.message:"材料尚未持久提交", "NATIVE_CONTEXT_EVIDENCE_INVALID");}
    for(const material of q.materials){const old=a.state.materials.find(m=>m.materialId===material.materialId);
      if(old){if(hash(materialInput(old))!==hash(material))throw fail("材料身份或内容摘要发生变化");continue;}
      if(material.eventSeq<=a.state.retiredThroughSeq)continue;
      a.state.materials.push({...material,state:"retained",pinnedByUser:false,pinnedByModel:false,createdAt:new Date().toISOString(),releasedReferenceIds:[]});changed=true;}
    if(changed)this.save(a,a.state);return this.status(q);
  }
  async releasePlans(input: NativeContextScope): Promise<NativeContextReleasePlans> {
    const q=nativeContextScopeSchema.parse(input);if(q.actor!=="host")throw fail("释放计划仅供原生宿主使用");
    const a=await this.access(q.runId,q.targetNativeSessionId);this.mergeSources(a.state,this.refs(a.scope,a.identity.logicalSessionId));
    const revoked=new Set(a.state.sources.filter(s=>["revoked","unavailable"].includes(s.authorityState)).map(s=>s.referenceId));
    const stale=a.state.materials.filter(m=>m.state==="retained"&&m.referenceIds.some(id=>revoked.has(id))&&m.referenceIds.every(id=>revoked.has(id)||m.releasedReferenceIds.includes(id)));
    let revision=a.revision;
    if(stale.length){const ids=this.releaseMaterials(a.state,stale,"host",true);const operationId=`revoke-${hash(ids)}`;
      a.state.operations.push(this.operation({...q,operationId,reason:"来源引用已解除或不可用"},hash(ids),"revoke-release",ids));revision=this.save(a,a.state);}
    return {items:a.state.operations.filter(op=>op.state==="pending-next-step"),materials:a.state.materials,revision};
  }
  async receipt(input: unknown) {
    const q=nativeContextReceiptSchema.parse(input);if(q.actor!=="host")throw fail("生效回执仅供原生宿主使用");
    const a=await this.access(q.runId,q.targetNativeSessionId),op=a.state.operations.find(op=>op.operationId===q.operationId);
    if(!op)throw fail("释放操作不存在或已裁剪");
    if(op.state==="applied")return this.status(q);
    let releasedBytes=0,surfaceEventSeqs=q.surfaceEventSeqs,sourceEventSeqs=q.sourceEventSeqs;
    if(q.state==="applied"){
      const materials=op.materialIds.map(id=>a.state.materials.find(m=>m.materialId===id));
      if(materials.some(m=>!m))throw fail("释放操作的原始材料记录不完整");
      const payload=await new JsonProjectionDirectory(projectionRootFor(this.engine.projectionRuntimeRoot,a.run.id)).readSession(q.targetNativeSessionId as NativeSessionId);
      try{const evidence=verifyV3NativeContextRelease(payload,{nativeSessionId:q.targetNativeSessionId,operationId:q.operationId,
        materials:materials.map(m=>materialInput(m!)),surfaceEventSeqs:q.surfaceEventSeqs,sourceEventSeqs:q.sourceEventSeqs});
        releasedBytes=evidence.releasedBytes;surfaceEventSeqs=[...evidence.surfaceEventSeqs];sourceEventSeqs=[...evidence.sourceEventSeqs];
      }catch(error){throw fail(error instanceof Error?error.message:"缺少实际原生替代事件，不能确认已释放", "NATIVE_CONTEXT_EVIDENCE_INVALID");}
    }
    for(const id of op.materialIds){const material=a.state.materials.find(m=>m.materialId===id);if(material&&material.state!=="released")material.state=q.state==="applied"?"released":"retained";}
    op.state=q.state;op.appliedAt=new Date().toISOString();op.surfaceEventSeqs=surfaceEventSeqs;op.sourceEventSeqs=sourceEventSeqs;op.releasedBytes=releasedBytes;
    if(q.reason)op.reason=q.reason;this.save(a,a.state);return this.status(q);
  }
  async graphEdit(input: unknown) {
    const q=nativeContextGraphEditSchema.parse(input),a=await this.access(q.runId,q.targetNativeSessionId),begun=this.begin(a,q,"graph-edit",[q.action,q.nodeId,q.label,q.sourceNativeSessionId,q.referenceId,q.sourceAnchorId,q.sourceVersionId]);
    if(begun.old)return this.status(q,true);
    const doc=await this.engine.sessionGraph.ensure(q.runId,a.identity.logicalSessionId);
    if(q.graphRevision!==undefined&&q.graphRevision!==doc.revision)throw fail(`主干图已改变（currentGraphRevision=${doc.revision}），请重新核对操作范围后重试`);
    const graph=structuredClone(doc.graph),node=q.nodeId?graph.nodes.find(n=>n.id===q.nodeId):undefined;
    let materialIds:string[]=[];
    if(q.action==="connect"){
      if(!q.sourceNativeSessionId||!q.sourceVersionId||!q.sourceAnchorId)throw fail("连接需要已完成来源回复及固定版本");
      await this.engine.sessionContext.capture({runId:q.runId,operationId:q.operationId,sourceNativeSessionId:q.sourceNativeSessionId,
        targetNativeSessionId:q.targetNativeSessionId,anchorId:q.sourceAnchorId,selectedText:"会话上下文",expectedSourceVersionId:q.sourceVersionId},record=>{
          this.mergeSources(a.state,this.refs(a.scope,a.identity.logicalSessionId));
          a.state.sources.find(s=>s.referenceId===record.referenceId)!.activation={operationId:q.operationId,executionId:q.executionId};
          a.state.operations.push(this.operation(q,begun.digest,"graph-edit",[]));this.save(a,a.state);
        });
    }else if(q.action==="disconnect"||q.action==="remove-node"){
      if(q.action==="remove-node"&&(!node||node.data.logicalSessionId===a.identity.logicalSessionId))throw fail("不能移除主干会话锚点或不存在的节点");
      const edges=q.action==="disconnect"?graph.edges.filter(e=>e.data.relationId===q.referenceId):graph.edges.filter(e=>e.source===q.nodeId||e.target===q.nodeId);
      if(q.action==="disconnect"&&(!q.referenceId||!edges.length))throw fail("连接不属于当前主干");
      const refs=edges.flatMap(e=>e.data.relationId?[e.data.relationId]:[]);
      for(const referenceId of refs)materialIds.push(...this.releaseMaterials(a.state,a.state.materials.filter(m=>m.referenceIds.includes(referenceId)),q.actor,true,referenceId));
      materialIds=[...new Set(materialIds)];
      await this.engine.sessionGraph.remove(q.runId,{objectId:doc.objectId,expectedRevision:doc.revision,operationId:q.operationId,
        ...(q.action==="remove-node"?{nodeIds:[q.nodeId!]}:{edgeIds:edges.map(e=>e.id)})},()=>{
          a.state.operations.push(this.operation(q,begun.digest,"graph-edit",materialIds));this.save(a,a.state);
        });
    }else{
      if(q.action==="rename"){if(!node||q.label===undefined)throw fail("需要当前图中的节点和新名称");node.data.label=q.label;}
      else {const source=q.action==="add-session"&&q.sourceNativeSessionId?await this.engine.sessionGraph.resolve(q.runId,{nativeSessionId:q.sourceNativeSessionId}):undefined;
        if(q.action==="add-session"&&!source)throw fail("请选择可见的来源会话");
        const y=graph.nodes.reduce((max,n)=>Math.max(max,n.position.y),0)+260;
        if(!graph.nodes.some(n=>n.id===`node-${hash(q.operationId)}`))graph.nodes.push({id:`node-${hash(q.operationId)}`,position:{x:450,y},data:source?{kind:"session",logicalSessionId:source.logicalSessionId,label:q.label??source.title}:{kind:"placeholder",label:q.label??"空卡片"}});}
      await this.engine.sessionGraph.save(q.runId,{objectId:doc.objectId,expectedRevision:doc.revision,graph},()=>{
        a.state.operations.push(this.operation(q,begun.digest,"graph-edit",[]));this.save(a,a.state);
      });
    }
    return this.status(q,true);
  }
}
