import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ExtensionDataError, nativeContextScopeSchema, userRequestListSchema, knowledgeLinkSchema } from "@linmu/dsh-session-contracts";
import type { SessionMaintenanceEngine } from "../engine.js";
import { readJsonBody } from "./body.js";

const id=z.string().min(1).max(256);
const metadata=z.strictObject({modelReadBytes:z.number().int().min(1024).max(4000).optional(),totalBytes:z.number().int().min(1024).max(64000).optional()});
const send=(response:ServerResponse,value:unknown)=>{response.setHeader("content-type","application/json; charset=utf-8");response.end(JSON.stringify(value));};
export async function routeNativeContext(request:IncomingMessage,response:ServerResponse,url:URL,engine:SessionMaintenanceEngine,ui=false) {
  const staticMatch=/^\/v1\/canonical\/sessions\/([^/]+)\/requests$/.exec(url.pathname);
  if(staticMatch&&request.method==="GET"){
    const query=z.strictObject({logicalSessionId:id,cursor:z.string().max(4096).optional(),requestId:id.optional(),limit:z.coerce.number().int().min(1).max(25).optional(),maxBytes:z.coerce.number().int().min(2048).max(16000).optional()})
      .parse({logicalSessionId:decodeURIComponent(staticMatch[1]!),...Object.fromEntries(url.searchParams)});
    send(response,await engine.userRequests.listSession(query));return true;
  }
  if(!url.pathname.startsWith("/v1/native-context/")||request.method!=="POST")return false;
  const operation=url.pathname.slice("/v1/native-context/".length);
  const body=await readJsonBody(request,512*1024) as Record<string,unknown>;
  if(ui){
    if(["materials-register","release-plans","release-receipt"].includes(operation))throw new ExtensionDataError("NATIVE_CONTEXT_HOST_ONLY","原生执行回执只能由宿主提交",403);
    body.actor="user";
  }
  const {runId,targetNativeSessionId,actor,executionId}=body;
  const scope=nativeContextScopeSchema.parse({runId,targetNativeSessionId,actor,executionId});
  let result:unknown;
  if(operation==="status"||operation==="inspect"){
    const q=nativeContextScopeSchema.extend(metadata.shape).parse(body);
    const read=()=>engine.nativeContext.status(scope,operation==="inspect");
    result=q.actor==="model"&&q.modelReadBytes!==undefined?await engine.nativeContext.metadataRead(scope,q.modelReadBytes,q.totalBytes??24000,read):await read();
  }
  else if(operation==="requests"){
    const {actor:_actor,...query}=body;
    result=await engine.userRequests.list(userRequestListSchema.parse(query),{preview:scope.actor==="user"});
  }else if(operation==="user-read"){
    if(scope.actor!=="user")throw new ExtensionDataError("NATIVE_CONTEXT_USER_ONLY","问答预览只供用户查看",403);
    const q=nativeContextScopeSchema.extend({referenceId:id,userRequestId:id,cursor:z.string().max(2048).optional()}).parse(body);
    result=await engine.sessionContext.read({runId:q.runId,targetNativeSessionId:q.targetNativeSessionId,executionId:q.executionId,
      referenceId:q.referenceId,userRequestId:q.userRequestId,...(q.cursor?{cursor:q.cursor}:{}),maxBytes:8000},{preview:true});
  }else if(operation==="discover"){
    const q=nativeContextScopeSchema.extend({...metadata.shape,kind:z.enum(["sessions","notes"]).default("sessions"),workspaceId:id.optional(),after:id.optional(),query:z.string().max(200).optional(),sourceNativeSessionId:id.optional()}).parse(body);
    const discover=async()=>{
    await engine.nativeContext.status(scope);
    if(q.kind==="notes"){
      if(q.workspaceId||q.sourceNativeSessionId)throw new ExtensionDataError("NATIVE_CONTEXT_SCOPE","笔记候选仅来自当前会话已关联的笔记",400);
      const owner=await engine.sessionGraph.resolve(q.runId,{nativeSessionId:q.targetNativeSessionId});
      const page=await engine.sessionKnowledge.list(q.runId,{namespace:"obsidian-links",logicalSessionId:owner.logicalSessionId,after:q.after,deleted:"active"});
      const items=[];let nextCursor=page.nextCursor;
      for(const object of page.items){const link=knowledgeLinkSchema.parse(object.content.body);
        const item={id:object.objectId,kind:"note-link",note:{vaultId:link.note.vaultId.slice(0,200),notePath:link.note.notePath.slice(0,600),
          locatorTruncated:link.note.vaultId.length>200||link.note.notePath.length>600},syncState:link.syncState,bodyAuthorized:false};
        if(q.query&&!JSON.stringify(item).toLocaleLowerCase().includes(q.query.toLocaleLowerCase()))continue;
        if(Buffer.byteLength(JSON.stringify({items:[...items,item],nextCursor:object.objectId}))>3900){nextCursor=items.at(-1)?.id??q.after??null;break;}items.push(item);}
      return {items,nextCursor};
    }else if(q.sourceNativeSessionId){
      const source=await engine.sessionGraph.resolve(q.runId,{nativeSessionId:q.sourceNativeSessionId});
      const preview=await engine.sessionGraph.preview(q.runId,source.logicalSessionId);
      return {items:[{...source,sourceVersionId:preview.sourceVersionId,sourceAnchorId:preview.capture.anchorId,completed:true}],nextCursor:null};
    }else{
      const page=await engine.sessionGraph.directory(q.runId,q.workspaceId,q.after);
      const items=[];let nextCursor=page.nextCursor;
      for(const original of page.items){const item={...original,title:original.title.slice(0,200)};
        if(q.query&&!item.title.toLocaleLowerCase().includes(q.query.toLocaleLowerCase()))continue;
        if(Buffer.byteLength(JSON.stringify({items:[...items,item],nextCursor:item.id}))>3900){nextCursor=items.at(-1)?.id??q.after??null;break;}items.push(item);}
      return {items,nextCursor};
    }
    };
    result=q.actor==="model"&&q.modelReadBytes!==undefined?await engine.nativeContext.metadataRead(scope,q.modelReadBytes,q.totalBytes??24000,discover):await discover();
  }else result=await engine.runWrite(`native-context-${operation}`,async()=>{
    if(operation==="window-set")return engine.nativeContext.windowSet(body);
    if(operation==="source-set")return engine.nativeContext.sourceSet(body);
    if(operation==="pin")return engine.nativeContext.pin(body);
    if(operation==="release")return engine.nativeContext.release(body);
    if(operation==="graph-edit")return engine.nativeContext.graphEdit(body);
    if(operation==="materials-register")return engine.nativeContext.registerMaterials(body);
    if(operation==="release-plans")return engine.nativeContext.releasePlans(nativeContextScopeSchema.parse(body));
    if(operation==="release-receipt")return engine.nativeContext.receipt(body);
    throw new ExtensionDataError("NATIVE_CONTEXT_OPERATION","没有这个原生上下文操作",404);
  });
  send(response,result);return true;
}
