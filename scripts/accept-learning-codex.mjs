// Isolated Codex protocol acceptance: local deterministic Responses endpoint, no account or model calls.
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { StdioAppServerTransport, CodexLearningAdapter } from '../packages/adapter-codex-continuation/dist/index.js';
const root = await mkdtemp(join(tmpdir(), 'maintenance-learning-fixture-'));
let requestBody, requests = 0;
const server = createServer(async (req, res) => {
  const chunks=[];for await (const c of req) chunks.push(c);
  if (!req.url?.endsWith('/responses')) { res.writeHead(404);res.end();return; }
  requestBody=JSON.parse(Buffer.concat(chunks).toString());requests++;
  const item={type:'message',id:'msg_fixture',role:'assistant',status:'completed',content:[{type:'output_text',text:'SYNTHETIC_REPLY_OK',annotations:[]}]};
  const response={id:'resp_fixture',object:'response',created_at:1789600000,status:'completed',model:'gpt-5.5',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
  res.writeHead(200,{'content-type':'text/event-stream'});
  const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},
    {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},
    {type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},
    {type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'SYNTHETIC_REPLY_OK'},
    {type:'response.output_text.done',item_id:item.id,output_index:0,content_index:0,text:'SYNTHETIC_REPLY_OK'},
    {type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}];
  for (const [sequence_number,event] of events.entries()) res.write(`event: ${event.type}\ndata: ${JSON.stringify({...event,sequence_number})}\n\n`);
  res.end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}/v1`;
await writeFile(join(root,'config.toml'),`model = "gpt-5.5"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Isolated test fixture"\nbase_url = "${origin}"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
const target={id:'fixture',codexInstanceId:'fixture',platformVersion:'0.153.4',cwd:root,runtimeWorkspaceRoots:[root],contextWindowTokens:32000,inputBudgetRatio:.75,codexHome:root};
async function transport(){const t=new StdioAppServerTransport(target);await t.version();await t.request('initialize',{clientInfo:{name:'learning-test',version:'1'},capabilities:{experimentalApi:true}});await t.notify('initialized');return t;}
let t;
const timeout=setTimeout(()=>{console.error('fixture acceptance timeout');process.exit(1);},55000);
try {
  t=await transport();const {thread}=await t.request('thread/start',{cwd:root,ephemeral:false,historyMode:'legacy'});await t.request('thread/inject_items',{threadId:thread.id,items:[{type:'message',role:'user',content:[{type:'input_text',text:'Synthetic initial context.'}]},{type:'message',role:'assistant',content:[{type:'output_text',text:'Ready for synthetic learning.'}]}]});await t.close();t=undefined;
  console.log('fixture persisted');
  const port=new CodexLearningAdapter();const before=await port.read(target,thread.id);console.log("fixture read");
  const projected=await port.inject(target,thread.id,before.cursor,'fixture-operation',[{id:'u',role:'user',text:'FIXTURE_LEARNING_CONTEXT_742: What is 2+2?',startedAt:null,completedAt:null},{id:'a',role:'assistant',text:'The answer is four.',startedAt:null,completedAt:null}]);
  console.log("injected");const restored=await port.read(target,thread.id);assert.equal(restored.messages.length,4);
  t=await transport();await t.request('thread/resume',{threadId:thread.id});console.log('resumed');
  const turn=await t.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'Continue the synthetic lesson.',text_elements:[]}]});
  await t.waitForNotification('turn/completed',n=>n.threadId===thread.id&&n.turn.id===turn.turn.id,20000);
  await t.close();t=undefined;
  assert.equal(requests,1);assert.ok(JSON.stringify(requestBody.input).includes('FIXTURE_LEARNING_CONTEXT_742'));
  assert.ok(JSON.stringify(requestBody.input).includes('The answer is four.'));
  const collected=await port.read(target,thread.id,projected.cursor);
  assert.equal(collected.busy,false);assert.equal(collected.messages.length,2);
  assert.equal(collected.messages[1].text,'SYNTHETIC_REPLY_OK');
  assert.ok(collected.messages.every(m=>m.startedAt&&m.completedAt));
  console.log(JSON.stringify({passed:true,root,version:'0.153.4',persisted:true,reopened:true,contextInNextRequest:true,newMessages:collected.messages.length,realModelCalls:0}));
} finally {clearTimeout(timeout);await t?.close();await new Promise(resolve=>server.close(resolve));}
