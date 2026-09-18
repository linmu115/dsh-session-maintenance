import { useEffect, useState } from "react";
import { Button, Surface, LoadingState, EmptyState } from "@linmu/dsh-session-ui";
import { managedGraphSchema, type ExtensionPanel, type ExtensionScope, type ExtensionList, type ExtensionPage, type ExtensionDetail, type ExtensionWrite, type ExtensionWriteResult, type ExtensionConflict, type ExtensionCapabilities, type ExtensionPreview, type JsonValue } from "@linmu/dsh-session-contracts";
import { ExtensionBusinessDirectory, type ExtensionBusinessApi } from "./extension-business-directory.js";
import { nativeContextStateSchema } from "@linmu/dsh-session-contracts";
import { NativeContextDetail } from "./native-context-detail.js";
import { BusinessPages, type BusinessPagesApi } from "./business-pages.js";

export interface ExtensionPageApi extends BusinessPagesApi {
  listExtensionBusinessPanels?: ExtensionBusinessApi["listExtensionBusinessPanels"];
  listExtensionDirectory?: ExtensionBusinessApi["listExtensionDirectory"];
  listExtensionPanels(signal?: AbortSignal): Promise<ExtensionPanel[]>;
  enableExtension(scope: ExtensionScope, enabled: boolean): Promise<ExtensionPanel[]>;
  listExtensionObjects(query: ExtensionList, signal?: AbortSignal): Promise<ExtensionPage>;
  getExtensionObject(scope: ExtensionScope, id: string, signal?: AbortSignal): Promise<ExtensionDetail>;
  writeExtensionObject(input: ExtensionWrite): Promise<ExtensionWriteResult>;
  getExtensionConflict(scope: ExtensionScope, id: string, signal?: AbortSignal): Promise<ExtensionConflict>;
  resolveExtensionConflict(scope: ExtensionScope, id: string, revision: number, choice: "current" | "incoming"): Promise<ExtensionWriteResult>;
}
const errorText = (e: unknown) => e instanceof Error ? e.message : "扩展数据暂时无法读取";
const labels = { ready:"已接入",disabled:"已停用，数据保留","missing-adapter":"缺少适配器，数据保留",incompatible:"版本不兼容，数据保留" };
const scopeKey = (scope: ExtensionScope) => JSON.stringify(scope);

export function ExtensionPageView({api,onOpenSession}:{api:ExtensionPageApi;onOpenSession:(id:string)=>void}) {
  const renderDetail: Parameters<typeof ExtensionBusinessDirectory>[0]["renderDetail"] = (object, member, onChanged) => <ObjectEditor key={`${scopeKey(object.scope)}:${object.objectId}:${object.revision}`} api={api} scope={object.scope} capabilities={member.capabilities!} id={object.objectId} readOnly={object.readOnly} onChanged={onChanged} onOpenSession={onOpenSession}/>;
  return <><BusinessPages api={api} renderDirectory={(owner, adapterId) => api.listExtensionBusinessPanels && api.listExtensionDirectory
    ? <ExtensionBusinessDirectory api={{ ...api, listExtensionDirectory: api.listExtensionDirectory.bind(api), enableExtension: api.enableExtension.bind(api),
      listExtensionBusinessPanels: async (_filter, signal) => (await api.listExtensionBusinessPanels!({ instanceId: owner.instanceId, profileId: owner.profileId }, signal)).filter(panel => panel.adapterId === adapterId && panel.scope.instanceId === owner.instanceId && panel.scope.profileId === owner.profileId),
    }} onOpenSession={onOpenSession} renderDetail={renderDetail} /> : <p>当前引擎未提供该数据目录。</p>} />
    {api.listExtensionBusinessPanels && api.listExtensionDirectory ? <ExtensionBusinessDirectory api={api as ExtensionBusinessApi} onOpenSession={onOpenSession} renderDetail={renderDetail} /> : <LegacyExtensionPage api={api} onOpenSession={onOpenSession}/>}</>;
}
function LegacyExtensionPage({api,onOpenSession}:{api:ExtensionPageApi;onOpenSession:(id:string)=>void}) {
  const [panels,setPanels]=useState<ExtensionPanel[]>();
  const [selected,setSelected]=useState<string>();
  const [error,setError]=useState<string>();
  const [busy,setBusy]=useState(false);
  useEffect(()=>{const c=new AbortController();void api.listExtensionPanels(c.signal).then(p=>{if(!c.signal.aborted)setPanels(p);},e=>{if(!c.signal.aborted)setError(errorText(e));});return()=>c.abort();},[api]);
  const panel=panels?.find(p=>scopeKey(p.scope)===selected);
  const toggle=async(p:ExtensionPanel)=>{setBusy(true);setError(undefined);try{setPanels(await api.enableExtension(p.scope,!p.enabled));}catch(e){setError(errorText(e));}finally{setBusy(false);}};
  return <div className="page-stack"><div className="dsm-page-heading"><div><h2>扩展数据</h2><p>查看插件保存的画布、注释与知识链接。只有配置并启用的兼容插件可以读写对象。</p></div></div>
    {error ? <p role="alert" className="inline-error">{error}</p>:null}
    {!panels&&!error?<LoadingState label="正在读取扩展目录…"/>:null}
    {panels?.length===0?<Surface><EmptyState title="尚未接入扩展" description="插件通过 Maintenance 扩展接口接管保存后，对应的数据域会显示在这里。已有会话不会自动转换为插件对象。"/></Surface>:null}
    <div className="extension-panels">{panels?.map(p=><Surface key={scopeKey(p.scope)}><h3>{p.label}</h3><p>{p.scope.instanceId} · {p.scope.profileId}</p><p>{labels[p.status]} · {p.objectCount} 个对象 · {p.conflictCount} 个冲突 · {Math.ceil(p.bytes/1024)} KiB</p>
      <Button onClick={()=>setSelected(scopeKey(p.scope))}>查看{p.status==="ready"?"对象":"元数据"}</Button>{p.configured&&p.status!=="missing-adapter"&&p.status!=="incompatible"?<Button disabled={busy} onClick={()=>void toggle(p)}>{p.enabled?"停用":"启用"}</Button>:null}</Surface>)}</div>
    {panel?<ObjectDirectory key={`${selected}:${panel.status}`} api={api} panel={panel} onOpenSession={onOpenSession}/>:null}
  </div>;
}
function ObjectDirectory({api,panel,onOpenSession}:{api:ExtensionPageApi;panel:ExtensionPanel;onOpenSession:(id:string)=>void}) {
  const [page,setPage]=useState<ExtensionPage>();const [cursor,setCursor]=useState<string>();
  const [deleted,setDeleted]=useState<"active"|"deleted">("active");const [selected,setSelected]=useState<string>();
  const [revision,setRevision]=useState(0);const [error,setError]=useState<string>();
  useEffect(()=>{const c=new AbortController();setPage(undefined);setError(undefined);
    void api.listExtensionObjects({...panel.scope,limit:30,deleted,...(cursor?{after:cursor}:{})},c.signal).then(p=>{if(!c.signal.aborted)setPage(p);},e=>{if(!c.signal.aborted)setError(errorText(e));});return()=>c.abort();
  },[api,panel.scope,cursor,deleted,revision]);
  return <Surface><h3>{panel.label} · 对象目录</h3><label>显示 <select value={deleted} onChange={e=>{setDeleted(e.target.value as "active"|"deleted");setCursor(undefined);setSelected(undefined);}}><option value="active">当前对象</option><option value="deleted">{panel.scope.namespace === "thoughtdag" ? "已归档或删除" : "已删除"}</option></select></label>
    {error?<p role="alert">{error}</p>:!page?<LoadingState label="正在读取对象元数据…"/>:null}
    {page?.items.length===0?<p>此页没有对象。</p>:null}
    <ul>{page?.items.map(o=><li key={o.objectId}><strong>{o.title||o.objectId}</strong> · 版本 {o.revision} · {o.conflicts} 个冲突 <small>{o.updatedAt}</small>
      {panel.status==="ready"&&panel.capabilities?.read?<Button onClick={()=>setSelected(o.objectId)}>打开</Button>:<code>{o.objectId}</code>}</li>)}</ul>
    {cursor?<Button onClick={()=>{setCursor(undefined);setSelected(undefined);}}>回到第一页</Button>:null}
    {page?.nextCursor?<Button onClick={()=>{setCursor(page.nextCursor!);setSelected(undefined);}}>下一页</Button>:null}
    {selected&&panel.status==="ready"&&panel.capabilities?.read?<ObjectEditor key={`${selected}:${revision}`} api={api} scope={panel.scope} capabilities={panel.capabilities} id={selected} onChanged={()=>setRevision(n=>n+1)} onOpenSession={onOpenSession}/>:null}
  </Surface>;
}
function ObjectEditor({api,scope,capabilities,id,readOnly=false,onChanged,onOpenSession}:{api:ExtensionPageApi;scope:ExtensionScope;capabilities:ExtensionCapabilities;id:string;readOnly?:boolean;onChanged:()=>void;onOpenSession:(id:string)=>void}) {
  readOnly = readOnly || scope.namespace === "annotation-context";
  const [detail,setDetail]=useState<ExtensionDetail>();const [title,setTitle]=useState("");const [body,setBody]=useState("");
  const [conflict,setConflict]=useState<ExtensionConflict>();const [error,setError]=useState<string>();const [busy,setBusy]=useState(false);
  const [showRaw,setShowRaw]=useState(false);
  const managedGraph=scope.namespace==="thoughtdag"&&Boolean(detail?.object.content.body&&typeof detail.object.content.body==="object"&&"managedSchema" in detail.object.content.body);
  const graphDetail=managedGraphSchema.safeParse(detail?.object.content.body);
  const contextDetail=scope.namespace==="annotation-context" ? nativeContextStateSchema.safeParse(detail?.object.content.body) : undefined;
  useEffect(()=>{const c=new AbortController();void api.getExtensionObject(scope,id,c.signal).then(d=>{if(c.signal.aborted)return;setDetail(d);setTitle(d.object.content.title);setBody(JSON.stringify(d.object.content.body,null,2));},e=>{if(!c.signal.aborted)setError(errorText(e));});return()=>c.abort();},[api,scope,id]);
  const perform=async(action:()=>Promise<unknown>)=>{setBusy(true);setError(undefined);try{await action();}catch(e){setError(errorText(e));}finally{setBusy(false);}};
  const save=async(deleted:boolean)=>{if(!detail)return;const o=detail.object;
    const result=await api.writeExtensionObject({scope,objectId:id,writerId:o.writerId,expectedRevision:o.revision,deleted,
      content:deleted!==o.deleted?o.content:{...o.content,title,body:JSON.parse(body) as JsonValue}});
    if(result.status==="conflict")setConflict(result.conflict);else onChanged();
  };
  return <section className="extension-editor"><h4>对象详情</h4>{error?<p role="alert">{error}</p>:null}
    {!detail&&!error?<LoadingState label="正在读取所选对象…"/>:null}
    {detail?<><p>{detail.summary}</p><p>版本 {detail.object.revision} · {graphDetail.success&&graphDetail.data.archivedAt?"已随主干会话归档":detail.object.deleted?"已删除":"当前状态"}</p>
      {detail.preview?<ObjectPreview preview={detail.preview}/>:null}
      {contextDetail?.success ? <NativeContextDetail state={contextDetail.data} onOpenSession={onOpenSession}/> : null}
      {graphDetail.success?<div aria-label="主干固定来源"><p>主干会话：{graphDetail.data.ownerSessionId??"待绑定"}</p>
        {graphDetail.data.archivedAt?<p>此图随所属会话归档。恢复会话后可继续整理图谱；已解除的引用关系不会自动恢复。</p>:null}
        {graphDetail.data.migration?<p>{graphDetail.data.migration.reason}</p>:null}
        <ul>{graphDetail.data.edges.filter(e=>e.data.relationId).slice(0,100).map(e=><li key={e.id}>{e.data.relationId} · {e.data.state==="sent"?"已发送":"待发送"} · 固定上限 {e.data.cutoffEventId??"请在图中核验"} · 来源版本 {e.data.sourceVersionId??"待核验"}</li>)}</ul>
        <p>{graphDetail.data.removedRelationIds?.length??0} 条关系已移除。读取位置另存为同一主干的记录对象；记录只表示实际保存的披露回执，停用期间的读取不会补记。</p></div>:null}
      <div>{detail.object.content.references.map((r,i)=><Button key={i} onClick={()=>onOpenSession(r.logicalSessionId)}>关联会话 {r.logicalSessionId}{r.anchorId?` · ${r.anchorId}`:""}</Button>)}</div>
      {managedGraph?<p>主干结构、固定上限与读取位置在此查看。请在会话主干图中管理连接与移除，系统会同步停用对应引用。</p>:null}
      {readOnly && scope.namespace === "annotation-records" ? <p>此条目由引用插件同步。请在会话或 Obsidian 的引用入口修改或删除，变更后会同步到这里。</p> : null}
      {!readOnly && !managedGraph ? <label className="field">标题<input value={title} onChange={e=>setTitle(e.target.value)} disabled={busy||detail.object.deleted}/></label> : null}
      <details onToggle={event=>setShowRaw(event.currentTarget.open)}><summary>{managedGraph||readOnly?"查看对象内容（JSON）":"查看和编辑对象内容（JSON）"}</summary>{showRaw?<textarea className="extension-json" aria-label="对象内容" value={body} onChange={e=>setBody(e.target.value)} disabled={busy||detail.object.deleted||managedGraph||readOnly}/>:null}</details>
      {!readOnly&&!managedGraph&&!detail.object.deleted&&capabilities.write?<Button disabled={busy} onClick={()=>void perform(()=>save(false))}>保存编辑</Button>:null}
      {!readOnly&&!managedGraph&&capabilities.write&&(detail.object.deleted?capabilities.restore:capabilities.delete)?<Button disabled={busy} onClick={()=>void perform(()=>save(!detail.object.deleted))}>{detail.object.deleted?"恢复对象":"删除对象"}</Button>:null}
      {detail.conflictIds.map(cid=><Button key={cid} disabled={busy} onClick={()=>void perform(async()=>setConflict(await api.getExtensionConflict(scope,cid)))}>查看冲突 {cid.slice(0,8)}</Button>)}
    </>:null}
    {conflict?<section aria-label="处理编辑冲突"><h4>编辑冲突：两份内容均已保留</h4><p>处理前请比较双方内容。保留当前版本会移除本条候选，采用传入编辑会以新版本保存。</p>
      <details><summary>发生冲突时的当前内容</summary><pre>{JSON.stringify(conflict.current.content,null,2)}</pre></details>
      <details><summary>传入编辑{conflict.incoming.deleted?"（删除请求）":""}</summary><pre>{JSON.stringify(conflict.incoming.content,null,2)}</pre></details>
      {!readOnly&&!managedGraph?(["current","incoming"] as const).map(choice=><Button key={choice} disabled={busy||!detail} onClick={()=>void perform(async()=>{await api.resolveExtensionConflict(scope,conflict.id,detail!.object.revision,choice);onChanged();})}>{choice==="current"?"保留当前版本":"采用传入编辑"}</Button>):<p>请回到所属插件处理此条目的冲突。</p>}</section>:null}
  </section>;
}

function ObjectPreview({preview}:{preview:ExtensionPreview}) {
  if(preview.kind==="rows")return <div aria-label="扩展对象预览"><dl>{preview.rows.map((r,i)=><div key={i}><dt>{r.label}</dt><dd>{r.text}</dd></div>)}</dl>{preview.total>preview.rows.length?<p>预览前 {preview.rows.length} 项，共 {preview.total} 项。</p>:null}</div>;
  const xs=preview.nodes.map(n=>n.x),ys=preview.nodes.map(n=>n.y),minX=Math.min(...xs),minY=Math.min(...ys);
  const spanX=Math.max(...xs)-minX,spanY=Math.max(...ys)-minY;
  const grid=!Number.isFinite(spanX)||!Number.isFinite(spanY);
  const points=new Map(preview.nodes.map((n,i)=>[n.id,{...n,x:grid?55+(i%5)*140:70+(n.x-minX)/(spanX||1)*540,y:grid?30+Math.floor(i/5)*45:35+(n.y-minY)/(spanY||1)*300}]));
  const height=grid?Math.max(120,Math.ceil(points.size/5)*45):370;
  return <figure className="extension-graph"><svg viewBox={`0 0 700 ${height}`} role="img" aria-label="画布节点和连线预览">
    {preview.edges.map((e,i)=>{const from=points.get(e.source),to=points.get(e.target);return from&&to?<line key={i} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="currentColor" opacity="0.35"/>:null;})}
    {[...points.values()].map(n=><g key={n.id}><title>{n.label}</title><rect x={n.x-60} y={n.y-15} width="120" height="30" rx="6" fill="Canvas" stroke="currentColor"/><text x={n.x} y={n.y+4} textAnchor="middle" fontSize="11" fill="currentColor">{n.label.slice(0,13)}</text></g>)}
  </svg><figcaption>节点布局预览{preview.total>preview.nodes.length?`（前 ${preview.nodes.length} 个，共 ${preview.total} 个节点）`:""}。图结构编辑仍由业务插件负责。</figcaption></figure>;
}
