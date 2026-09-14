import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { WebServer } from '@deepseek-ai/dsh-host-webserver';
import { knowledgeHandler, MaintenanceKnowledge, registerMaintenanceKnowledge } from '../src/session-knowledge.js';

it('lists authoritative source markers through the current graph host and rejects retired global operations',async()=>{
  const sourceMarkers=vi.fn(async()=>({items:[],nextCursor:null}));
  const current=vi.fn(async()=>({origin:'http://unused',token:'synthetic'}));
  const service=new MaintenanceKnowledge({current},'run',{maintenanceGraph:{sourceMarkers}} as never);
  expect(await service.dispatch('source-markers',{nativeSessionId:'source',after:'page'})).toEqual({items:[],nextCursor:null});
  expect(sourceMarkers).toHaveBeenCalledWith('source','page');expect(current).not.toHaveBeenCalled();
  await expect(service.dispatch('source-markers',{})).rejects.toThrow('身份');
  for(const operation of ['network','impact'])await expect(service.dispatch(operation,{})).rejects.toThrow('不支持');
});

it('dispatches descendant API paths through the official RC2 host router',async()=>{
  const ctx=new Context();
  await ctx.plugin(WebServer,{host:'127.0.0.1',port:0});
  const dispatch=vi.fn(async()=>({instanceId:'synthetic-instance'}));
  const knowledge={dispatch} as unknown as MaintenanceKnowledge;
  registerMaintenanceKnowledge(ctx,knowledge);
  const fallback=vi.fn((_request,response)=>{response.writeHead(405);response.end();});
  ctx.webServer.registerFallback(fallback);
  const origin='http://127.0.0.1:'+ctx.webServer.port;
  const post=(path:string)=>fetch(origin+path,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'});
  try {
    const response=await post('/maintenance-knowledge/api/status');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({instanceId:'synthetic-instance'});
    expect(dispatch).toHaveBeenCalledWith('status',{});
    expect(fallback).not.toHaveBeenCalled();
    expect((await post('/maintenance-knowledge/api-other/status')).status).toBe(405);
    expect(dispatch).toHaveBeenCalledTimes(1);
  } finally { await ctx.fiber.dispose(); }
});

it('accepts only same-origin bounded requests through the current host',async()=>{
  const dispatch=vi.fn(async()=>({items:[]}));
  const server=createServer(knowledgeHandler({dispatch}));server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const request=(headers:Record<string,string>,body='{}')=>fetch(origin+'/maintenance-knowledge/api/list',{method:'POST',headers:{'content-type':'application/json',...headers},body});
  try {
    expect((await request({origin:'https://foreign.example'})).status).toBe(403);
    expect((await request({origin:'file://'+new URL(origin).host})).status).toBe(403);
    expect((await request({})).status).toBe(403);expect(dispatch).not.toHaveBeenCalled();
    expect((await request({origin},JSON.stringify({namespace:'stickers'}))).status).toBe(200);
    expect(dispatch).toHaveBeenCalledWith('list',{namespace:'stickers'});
    expect((await request({origin},JSON.stringify({data:'x'.repeat(512*1024)}))).status).toBe(413);
  } finally { server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
it('retries a real session creation by stable operation without creating a second session',async()=>{
  const sessions=new Map(),created=vi.fn(async(id:string)=>({nativeSessionId:id,logicalSessionId:'logical',title:'new'}));
  const graph={resolve:vi.fn(async(input:{nativeSessionId:string})=>{if(!sessions.has(input.nativeSessionId))throw Object.assign(new Error('missing'),{code:'GRAPH_SESSION_NOT_FOUND'});return created(input.nativeSessionId);}),created};
  const controller={create:vi.fn(async(input:{sessionId:string})=>{sessions.set(input.sessionId,{});})};
  const ctx={maintenanceGraph:graph,sessions:{get:(id:string)=>sessions.get(id)},workspaceRegistry:{get:(id:string)=>id==='workspace'?{id}:undefined},get:()=>controller};
  const service=new MaintenanceKnowledge({current:async()=>({origin:'http://unused',token:'synthetic'})},'run',ctx as never);
  const [first,second]=await Promise.all([service.createSession('operation','workspace'),service.createSession('operation','workspace')]);
  expect(first).toEqual(second);expect(controller.create).toHaveBeenCalledTimes(1);
  const restarted=new MaintenanceKnowledge({current:async()=>({origin:'http://unused',token:'synthetic'})},'run',ctx as never);
  expect(await restarted.createSession('operation','workspace')).toEqual(first);expect(controller.create).toHaveBeenCalledTimes(1);
  expect(controller.create).toHaveBeenCalledWith({sessionId:expect.any(String),workspaceId:'workspace'});
  await expect(service.dispatch('create-session',{operationId:'invalid'})).rejects.toThrow('操作身份无效');
  await expect(service.createSession('invalid','deleted-workspace')).rejects.toThrow('工作区已不存在');
  expect(controller.create).toHaveBeenCalledTimes(1);
});

it('lists native workspaces including empty ones with stable paging', async()=>{
  const rows=Array.from({length:51},(_,i)=>({id:'native-'+String(i).padStart(2,'0'),title:'Workspace '+i,path:'C:/synthetic/'+i}));
  const ctx={workspaceRegistry:{list:()=>rows}};
  const service=new MaintenanceKnowledge({current:async()=>({origin:'http://unused',token:'synthetic'})},'run',ctx as never);
  const first=await service.dispatch('create-workspaces',{}) as any;
  expect(first.items).toHaveLength(50);expect(first.nextCursor).toBe('native-49');
  expect(await service.dispatch('create-workspaces',{after:first.nextCursor})).toEqual({items:[{id:'native-50',title:'Workspace 50'}],nextCursor:null});
});

it('reattaches the same native identity on retry after a partial controller failure', async()=>{
  const calls:any[]=[];let attached=false;
  const graph={resolve:vi.fn(async()=>{throw Object.assign(new Error('missing'),{code:'GRAPH_SESSION_NOT_FOUND'});}),created:vi.fn(async(id)=>({nativeSessionId:id}))};
  const controller={create:vi.fn(async(input)=>{calls.push(input);if(calls.length===1)throw new Error('attach interrupted');attached=true;})};
  const ctx={maintenanceGraph:graph,sessions:{get:()=>({})},workspaceRegistry:{get:()=>({id:'w'})},get:()=>controller};
  const service=new MaintenanceKnowledge({current:async()=>({origin:'http://unused',token:'synthetic'})},'run',ctx as never);
  await expect(service.createSession('op','w')).rejects.toThrow('attach interrupted');
  await service.createSession('op','w');expect(calls[0]).toEqual(calls[1]);expect(attached).toBe(true);
  await service.createSession('op','different-workspace');expect(calls[2].sessionId).not.toEqual(calls[0].sessionId);
});
