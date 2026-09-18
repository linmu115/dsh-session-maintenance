import { expect, it, vi } from 'vitest';
import { MaintenanceInstanceWorkspace } from '../src/instance-workspace.js';
import { MaintenanceKnowledge } from '../src/session-knowledge.js';

it('uses a fixed host instance/profile, keeps token inside transport, and rejects mismatched results',async()=>{
  const identity={instanceId:'i-one',profileId:'web'}, current=vi.fn(async()=>({origin:'http://127.0.0.1:9000',token:'synthetic-secret'}));
  let availability={schemaVersion:1,instanceId:'i-one',profileId:'web',logicalSessionId:'session',workspaceId:null,policyRevision:2,status:'not-synced',nativeSessionId:null};
  const request=vi.fn(async()=>new Response(JSON.stringify({availability}),{status:200}));
  const service=new MaintenanceInstanceWorkspace(identity,{current},request as never);
  expect(await service.sessionAvailability('session')).toMatchObject({status:'not-synced'});
  expect(request.mock.calls[0]?.[0]).toBe('http://127.0.0.1:9000/v1/instances/i-one/sessions/session/availability?profileId=web');
  availability={...availability,instanceId:'i-other'};
  await expect(service.sessionAvailability('session')).rejects.toThrow('identity mismatch');
});

it('uses optional host scope service for same-origin knowledge operations and reports missing service explicitly',async()=>{
  const service={effectiveScope:vi.fn(async()=>({selection:{kind:'all'}})),sessionAvailability:vi.fn(async()=>({status:'not-synced'}))};
  const knowledge=new MaintenanceKnowledge({current:vi.fn()} as never,'run',{get:()=>service} as never);
  expect(await knowledge.dispatch('session-availability',{logicalSessionId:'session'})).toEqual({status:'not-synced'});
  expect(service.sessionAvailability).toHaveBeenCalledWith('session');
  expect(await knowledge.dispatch('workspace-scope',{})).toEqual({selection:{kind:'all'}});
  const absent=new MaintenanceKnowledge({current:vi.fn()} as never,'run',{get:()=>undefined} as never);
  await expect(absent.dispatch('workspace-scope',{})).rejects.toMatchObject({code:'INSTANCE_WORKSPACE_UNAVAILABLE'});
});
