import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { knowledgeHandler, MaintenanceKnowledge } from '../src/session-knowledge.js';

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
  const ctx={maintenanceGraph:graph,sessions:{get:(id:string)=>sessions.get(id)},get:()=>controller};
  const service=new MaintenanceKnowledge({current:async()=>({origin:'http://unused',token:'synthetic'})},'run',ctx as never);
  const [first,second]=await Promise.all([service.createSession('operation'),service.createSession('operation')]);
  expect(first).toEqual(second);expect(controller.create).toHaveBeenCalledTimes(1);
  const restarted=new MaintenanceKnowledge({current:async()=>({origin:'http://unused',token:'synthetic'})},'run',ctx as never);
  expect(await restarted.createSession('operation')).toEqual(first);expect(controller.create).toHaveBeenCalledTimes(1);
});
