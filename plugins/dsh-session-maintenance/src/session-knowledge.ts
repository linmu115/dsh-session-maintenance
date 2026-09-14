import { createHash } from 'node:crypto';
import type { IncomingMessage,ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { EngineConnectionProvider } from './engine-proxy.js';
const operations=new Set(['status','list','get','write','migrate','network','impact','legacy-state','legacy-save']);
const wrapped = new Set(['list','write','migrate','network','impact','legacy-save']);
const id=(value:unknown)=>{if(typeof value!=='string'||!value.trim()||value.length>256)throw new Error('操作身份无效');return value;};
export class MaintenanceKnowledge {
  readonly protocolVersion=1;
  private readonly creates=new Map<string,Promise<unknown>>();
  constructor(private readonly connection:EngineConnectionProvider,private readonly runId:string,private readonly ctx:Context){}
  async request(operation:string,input:Record<string,unknown>={}) {
    if(!operations.has(operation))throw new Error('不支持此知识操作');
    if('runId' in input)throw new Error('不能更改当前实例');
    const connection=await this.connection.current();
    const response=await fetch(connection.origin+'/v1/session-knowledge/'+operation,{method:'POST',headers:{authorization:`Bearer ${connection.token}`,'content-type':'application/json'},body:JSON.stringify({...(wrapped.has(operation)?{input}:input),runId:this.runId}),signal:AbortSignal.timeout(30000)});
    const result=await response.json() as {error?:{message?:string;code?:string}};
    if(!response.ok)throw Object.assign(new Error(result.error?.message??'知识操作未完成'),{code:result.error?.code,status:response.status});return result;
  }
  async createSession(operationId:string) {
    id(operationId);const pending=this.creates.get(operationId);if(pending)return pending;
    if(this.creates.size>=64)throw new Error('创建操作过多，请稍后重试');
    const sessionId='knowledge-'+createHash('sha256').update(operationId).digest('hex').slice(0,32);
    const task=(async()=>{
      try{return await this.ctx.maintenanceGraph.resolve({nativeSessionId:sessionId});}
      catch(e){if((e as {code?:string}).code!=='GRAPH_SESSION_NOT_FOUND')throw e;}
      const controller=this.ctx.get('sessionController') as unknown as {create(input:{sessionId:string}):Promise<unknown>}|undefined;
      if(!controller)throw new Error('DSH 会话控制器尚未就绪');
      if(!this.ctx.sessions.get(sessionId as never))await controller.create({sessionId});
      return this.ctx.maintenanceGraph.created(sessionId);
    })();this.creates.set(operationId,task);try{return await task;}finally{this.creates.delete(operationId);}
  }
  async dispatch(operation:string,input:Record<string,unknown>) {
    if(operation==='create-session')return this.createSession(id(input.operationId));
    if(operation==='directory')return this.ctx.maintenanceGraph.directory(input.workspaceId===undefined?undefined:id(input.workspaceId),input.after===undefined?undefined:id(input.after));
    if(operation==='resolve')return this.ctx.maintenanceGraph.resolve(input.logicalSessionId?{logicalSessionId:id(input.logicalSessionId)}:{nativeSessionId:id(input.nativeSessionId)});
    if(operation==='preview')return this.ctx.maintenanceGraph.preview(id(input.logicalSessionId),input.cursor===undefined?undefined:String(input.cursor),input.sourceVersionId?{sourceVersionId:id(input.sourceVersionId),sourceAnchorId:id(input.sourceAnchorId)}:undefined);
    return this.request(operation,input);
  }
}
export function knowledgeHandler(knowledge:Pick<MaintenanceKnowledge,'dispatch'>) {
  return async(request:IncomingMessage,response:ServerResponse)=>{
    try{
      const host=String(request.headers.host??'');if(!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))throw Object.assign(new Error('无效本地来源'),{status:403});
      const origin=request.headers.origin;let parsed:URL|undefined;
      try { if(origin)parsed=new URL(origin); } catch { /* Invalid origins fail the same source check. */ }
      if(!parsed||!['http:','https:'].includes(parsed.protocol)||parsed.host!==host||request.headers['sec-fetch-site']==='cross-site')throw Object.assign(new Error('操作必须来自当前会话窗口'),{status:403});
      if(request.method!=='POST')throw Object.assign(new Error('使用 POST 请求'),{status:405});
      if(!String(request.headers['content-type']??'').startsWith('application/json'))throw Object.assign(new Error('请求格式无效'),{status:415});
      const parts:Buffer[]=[];let count=0;for await(const part of request){count+=part.length;if(count>512*1024)throw Object.assign(new Error('单次内容过大'),{status:413});parts.push(part);}
      const input=JSON.parse(Buffer.concat(parts).toString());if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('请求格式无效');
      const operation=new URL(request.url??'/','http://localhost').pathname.slice('/maintenance-knowledge/api/'.length);
      const result=JSON.stringify(await knowledge.dispatch(operation,input));if(Buffer.byteLength(result)>1024*1024)throw new Error('本次结果超过读取额度，请缩小范围');response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});response.end(result);
    }catch(error){const e=error as {status?:number;code?:string;message?:string};response.writeHead(e.status??409,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify({error:{code:e.code??'KNOWLEDGE_ERROR',message:(e.message??'操作未完成').slice(0,1200)}}));}
  };
}
export function registerMaintenanceKnowledge(ctx:Context,knowledge:MaintenanceKnowledge){
  ctx.provide('maintenanceKnowledge',knowledge);
  const server=ctx.get('webServer') as unknown as {register(input:{kind:'prefix';path:string;handler:ReturnType<typeof knowledgeHandler>}):()=>void};
  ctx.effect(()=>server.register({kind:'prefix',path:'/maintenance-knowledge/api/',handler:knowledgeHandler(knowledge)}),'maintenance knowledge');
}
declare module '@deepseek-ai/cordis' {interface Context{maintenanceKnowledge:MaintenanceKnowledge}}
