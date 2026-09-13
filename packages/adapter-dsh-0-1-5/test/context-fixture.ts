export const contextHeader={version:3,id:'source-native',createdAt:1,delegationDepth:0,isSeeded:false};
export function contextEvents(later = true): any[] {
  const events: any[] = [
    {type:'turn/start',data:{turn:1}}, {type:'step/start',data:{turn:1,step:1}},
    {type:'system/message',surfaceOp:'append',data:{turn:1,step:1,message:{id:'sys',role:'system',source:{kind:'plugin',plugin:'fixture'},content:[]}}},
    {type:'user/message',surfaceOp:'append',data:{id:'q1',role:'user',source:{kind:'user'},content:[{type:'text',text:'old question'}]}},
    {type:'assistant/message',surfaceOp:'append',data:{turn:1,step:1,message:{id:'reply-one',role:'assistant',source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'text',text:'selected passage and AFTER-SELECTION before finish'}]},stream:[]}},
    {type:'step/end',data:{turn:1,step:1}}, {type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
  ];
  if(later)events.push({type:'turn/start',data:{turn:2}}, {type:'step/start',data:{turn:2,step:1}},
    {type:'user/message',surfaceOp:'append',data:{id:'q2',role:'user',source:{kind:'user'},content:[{type:'text',text:'FUTURE-SENTINEL'}]}},
    {type:'assistant/message',surfaceOp:'append',data:{turn:2,step:1,message:{id:'reply-two',role:'assistant',source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'text',text:'FUTURE-ANSWER'}]},stream:[]}},
    {type:'step/end',data:{turn:2,step:1}}, {type:'turn/end',data:{turn:2,reason:{kind:'completed'}}});
  return events.map((event,seq)=>({...event,seq,time:seq+1}));
}
