// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { KnowledgeNetworkView } from '../src/knowledge-network.js';

it('queries independent inbound/outbound references and opens both complete session pages',async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node),onOpenSession=vi.fn();
  const reference={key:'annotation-upstream:ref',kind:'reference',title:'source → target',logicalSessionIds:['source','target'],deleted:false,available:false,conflicts:0,
    reference:{referenceId:'ref',sourceSessionId:'source',targetSessionId:'target',sourceVersionId:'version',sourceAnchorId:'anchor',state:'revoked',sourceTitle:'Source title',targetTitle:'Target title'}};
  const query=vi.fn(async(_run:string,input:Record<string,unknown>)=>({items:input.kind==='reference'?[reference]:[{key:'session:target',kind:'session',title:'Target title',logicalSessionIds:['target'],deleted:false,available:true,conflicts:0}],nextCursor:null}));
  const api={listProjectionRuns:async()=>[{run:{id:'run',instanceId:'copy',profileId:'web',state:'running'}}],queryKnowledgeNetwork:query,queryKnowledgeImpact:vi.fn()};
  const click=async(text:string)=>{const button=[...node.querySelectorAll('button')].find(b=>b.textContent===text);expect(button,text).toBeTruthy();await act(async()=>button!.click());};
  try{
    await act(async()=>root.render(<KnowledgeNetworkView api={api as any} onOpenSession={onOpenSession}/>));
    await click('查询网络');await click('引入的来源');
    expect(query).toHaveBeenLastCalledWith('run',expect.objectContaining({kind:'reference',logicalSessionId:'target',direction:'incoming'}));
    expect(node.textContent).toContain('已解除');await click('打开来源：Source title');await click('打开目标：Target title');
    expect(onOpenSession.mock.calls).toEqual([['source'],['target']]);
    await click('引用去向');expect(query).toHaveBeenLastCalledWith('run',expect.objectContaining({kind:'reference',logicalSessionId:'source',direction:'outgoing'}));
    expect(api.queryKnowledgeImpact).not.toHaveBeenCalled();
  }finally{await act(async()=>root.unmount());node.remove();}
});
