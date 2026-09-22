import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createEngineFixture, hashTree } from './helpers.js';
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});

it('composes authenticated workspace policy and public page routes without writing platform homes',async()=>{
  const fixture=await createEngineFixture('instance-workspace-http',{withContinuationTarget:true});cleanups.push(fixture.cleanupAll);
  const before=await hashTree(fixture.dshHome), server=await fixture.startServer();
  const headers={authorization:`Bearer ${server.token}`,'content-type':'application/json'};
  const path='/v1/instances/dsh-fixture/workspace-sync';
  expect((await fetch(server.origin+path)).status).toBe(401);
  expect((await fetch(server.origin+path,{headers:{...headers,origin:'https://foreign.invalid'}})).status).toBe(403);
  const get=await fetch(server.origin+path,{headers});expect(get.status).toBe(200);
  expect((await get.json()).configuration.policy).toMatchObject({revision:0,selection:{kind:'ids',workspaceIds:[],includeUnassigned:false}});
  const save=()=>fetch(server.origin+path,{method:'PATCH',headers,body:JSON.stringify({expectedRevision:0,selection:{kind:'ids',workspaceIds:[],includeUnassigned:false}})});
  expect((await save()).status).toBe(200);expect((await save()).status).toBe(409);
  const list=await fetch(server.origin+'/v1/business-pages',{headers});expect(list.status).toBe(200);expect(await list.json()).toEqual({pages:[]});
  const registration={owner:{instanceId:'dsh-fixture',profileId:'web',namespace:'synthetic',providerId:'test',bootId:randomUUID()},snapshot:{title:'Synthetic information',revision:0,sections:[{id:'status',title:'Status',kind:'summary',text:'Ready'}]}};
  expect((await fetch(server.origin+'/v1/business-pages/register',{method:'POST',headers,body:JSON.stringify(registration)})).status).toBe(200);
  const pages=await fetch(server.origin+'/v1/business-pages',{headers});expect((await pages.json()).pages[0]).toMatchObject({online:true,snapshot:{title:'Synthetic information'}});
  expect(await hashTree(fixture.dshHome)).toBe(before);
});

it('authenticates and validates the scoped epoch protocol through the actual HTTP server', async () => {
  const fixture = await createEngineFixture('endpoint-sync-http'); cleanups.push(fixture.cleanupAll);
  const server = await fixture.startServer(), service = fixture.engine.instanceWorkspace!;
  const status = vi.spyOn(service, 'syncStatus').mockResolvedValue({ epoch: 'batch-one', phase: 'active', policyRevision: 1 });
  const commit = vi.spyOn(service, 'syncChange').mockResolvedValue({ epoch: 'batch-one', logicalSessionId: 'logical', outcome: 'updated', archived: true });
  const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };
  const path = '/v1/instances/dsh-fixture/sync-changes';
  const body = { epoch: 'batch-one', profileId: 'web', sessionId: 'native', change: { kind: 'archive', archived: true } };
  expect((await fetch(server.origin + path, { method: 'POST', body: JSON.stringify(body) })).status).toBe(401);
  expect((await fetch(server.origin + path, { method: 'POST', headers, body: JSON.stringify({ ...body, homeRoot: 'untrusted' }) })).status).toBe(400);
  expect(commit).not.toHaveBeenCalled();
  const response = await fetch(server.origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
  expect(response.status).toBe(200); expect((await response.json()).receipt.epoch).toBe('batch-one');
  expect(commit).toHaveBeenCalledWith('dsh-fixture', body);
  expect((await fetch(server.origin + '/v1/instances/dsh-fixture/sync-state?profileId=web', { headers })).status).toBe(200);
  expect(status).toHaveBeenCalledWith('dsh-fixture', 'web');
});
