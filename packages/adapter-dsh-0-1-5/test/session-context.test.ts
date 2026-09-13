import { describe, expect, it } from 'vitest';
import { normalizeV3Append } from '../src/normalize-append.js';
import { v3SessionContext } from '../src/session-context.js';
import { materializeV3 } from '../src/materialize.js';
import { CANONICAL_CONVERSATION_TOPOLOGY_EXTENSION as TOPOLOGY } from '@linmu/dsh-session-contracts';

const at='2026-09-13T00:00:00Z';
import { contextHeader, contextEvents } from './context-fixture.js';
async function native(events=contextEvents()) {
  const canonical=await normalizeV3Append({runId:'run',nativeSessionId:contextHeader.id,operationId:'op',nativeRevision:events.length,
    observedAt:at,payload:{logicalSessionId:'logical-source',instanceId:'fixture',header:contextHeader,inheritedEventCount:0,events}} as any);
  return {events:canonical.events,payload:{events,header:contextHeader,inheritedEventCount:0}};
}
describe('RC2 completed-reply range',()=>{
  it('resolves a cold imported Codex reply through its canonical archive mapping',async()=>{
    const events=['user-message','assistant-message','user-message','assistant-message'].map((kind,sequence)=>({
      schemaVersion:1,id:`portable-${sequence}`,logicalSessionId:'portable',sequence,kind,role:kind==='user-message'?'user':'assistant',
      content:{id:`message-${sequence}`,text:sequence<2?'first turn':'LATER-IMPORTED'},contentDigest:`digest-${sequence}`,
      source:{platform:'codex',instanceId:'fixture',sessionId:'original',eventId:String(sequence),cursor:String(sequence)},rawPayload:{original:true},
      extensions:{[TOPOLOGY]:{schemaVersion:1,turnId:`turn-${Math.floor(sequence/2)}`,turnOrdinal:Math.floor(sequence/2),
        stepId:kind==='assistant-message'?`step-${sequence}`:null,stepOrdinal:kind==='assistant-message'?0:null,phase:kind==='assistant-message'?'assistant':'user',inference:'derived'}},
    }));
    let projection:any;
    await materializeV3({run:{id:'run',instanceId:'fixture',profileId:'web'},workspaces:[],sessions:[{
      session:{id:'portable',headVersionId:'version',createdAt:at,updatedAt:at,title:'imported',tags:[]},events,workspaceId:null,
    }]} as any,{writeWorkspace:async()=>{},writeSession:async(_id,payload)=>{projection=payload;}});
    expect(v3SessionContext.cutoff(events as any,projection,'message-1').eventId).toBe('portable-1');
    expect(v3SessionContext.selectedTurnStart(events as any)).toBe('portable-2');
    expect(v3SessionContext.selectedReply(events as any)).toBe('portable-3');
    expect(JSON.stringify(v3SessionContext.entries(events.slice(0,2) as any))).not.toContain('LATER-IMPORTED');
  });
  it('cuts at the complete selected reply, includes its remainder, excludes all later turns',async()=>{
    const f=await native();
    expect(v3SessionContext.selectedTurnStart(f.events.slice(0,5))).toBe(f.events[3]!.id);
    expect(v3SessionContext.selectedReply(f.events.slice(0,5))).toBe(f.events[4]!.id);
    expect(v3SessionContext.selectedTurnStart(f.events)).toBe(f.events[9]!.id);
    const cut=v3SessionContext.cutoff(f.events,f.payload,'14:assistant-step1:1');
    expect(cut.eventId).toBe(f.events[4]!.id);
    const text=JSON.stringify(v3SessionContext.entries(f.events.slice(0,5)));
    expect(text).toContain('AFTER-SELECTION');expect(text).not.toContain('FUTURE');
    expect(v3SessionContext.cutoff(f.events,f.payload,'reply-one')).toEqual(cut);
  });
  it('rejects streaming/failed attempts and altered native/canonical prefixes',async()=>{
    const f=await native();
    expect(()=>v3SessionContext.cutoff(f.events.slice(0,5),{...f.payload,events:f.payload.events.slice(0,5)},'reply-one')).toThrow('等待');
    const bad=structuredClone(f.payload);bad.events[4]!.data.message.content[0].text='tampered';
    expect(()=>v3SessionContext.cutoff(f.events,bad,'reply-one')).toThrow('prefix');
    const attempt=structuredClone(f.payload);attempt.events[4]!.type='assistant/attempt';
    expect(()=>v3SessionContext.cutoff(f.events,attempt,'reply-one')).toThrow();
  });
  it('verifies the conversion receipt and keeps the same source range after rematerialization',async()=>{
    const f=await native();let projection:any;
    await materializeV3({run:{id:'run',instanceId:'fixture',profileId:'web'},workspaces:[],sessions:[{
      session:{id:'logical-source',headVersionId:'v1',createdAt:at,updatedAt:at,title:'source',tags:[]},events:f.events,workspaceId:null,
    }]} as any,{writeWorkspace:async()=>{},writeSession:async(_id,payload)=>{projection=payload;}});
    expect(v3SessionContext.cutoff(f.events,projection,'reply-one').eventId).toBe(f.events[4]!.id);
    projection.events[4].data.message.content[0].text='changed';
    expect(()=>v3SessionContext.cutoff(f.events,projection,'reply-one')).toThrow('receipt');
  });
});
