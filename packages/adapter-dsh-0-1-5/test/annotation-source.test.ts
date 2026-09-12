import { describe, it, expect } from "vitest";
import { migrateLegacy } from "../src/legacy-import.js";
import { visibleContext, sessionFormatCatalog } from "../src/official.js";
import { admitAnnotationSources } from "../src/annotation-source.js";
const source = { kind: "dsh-annotation", schemaVersion: 1, setId: "set-fixture", targetUserMessageId: "direct-user", count: 1, digest: "sha256:" + "a".repeat(64) };
const context = { id: "annotation-context", role: "user", source, content: [{ type: "text", text: "<dsh-annotations />" }] };
const rows = [
 { type: "turn/start", data: { turn: 1 } }, { type: "step/start", data: { turn: 1, step: 1 } },
 { type: "user/message", data: { id: "direct-user", role: "user", source: { kind: "user" }, content: [{type:"text",text:"question"}] }, surfaceOp: "append" },
 { type: "user/message", data: context, surfaceOp: "append" },
 { type: "session/title", data: {title:"fixture",messageSeqs:[2],source:{kind:"fallback"}} },
 { type: "step/end", data: { turn: 1, step: 1 } }, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
].map((e, seq) => ({ ...e, seq, time: seq + 1 }));
const artifact = { header: { version: 0, id: "synthetic-annotation", createdAt: 1, delegationDepth: 0, isSeeded: false }, events: rows, inheritedEventCount: 0 } as any;
describe("historical Annotation Core source preservation", () => {
 it("retains exact context source, target message and content after all official edges and V3 cold restore", () => {
  const before = JSON.stringify(artifact), result = migrateLegacy(artifact);
  expect(result.artifact.events.find(e => e.type === "user/message" && (e.data as any).id === context.id)?.data).toEqual(context);
  expect(visibleContext(result.artifact)).toEqual(expect.arrayContaining([expect.objectContaining(context)]));
  expect(result.artifact.events.find(e => e.type === "session/title")?.data).toMatchObject({source:{kind:"fallback"}});
  expect(result.ledger.annotationSources).toEqual([expect.objectContaining({messageId:context.id,source})]);
  expect(JSON.stringify(artifact)).toBe(before);
 });
 it("does not broadly admit future message source kinds or altered annotation schemas", () => {
  for (const changed of [{...source,kind:"future-semantic"},{...source,schemaVersion:2},{...source,hiddenSeq:2}]) {
   const input = {...artifact,events:rows.map(e=>e.seq===3?{...e,data:{...context,source:changed}}:e)};
   expect(()=>migrateLegacy(input)).toThrow();
  }
 });
 it("retains annotated inbox copies and fails if migration loses an admitted context", () => {
  const input = [{type:"agent/inbox/spliced",seq:0,time:1,data:{inserted:[context]}}] as any;
  const admitted = admitAnnotationSources(input);
  expect(admitted.restore(admitted.events)).toEqual(input);
  expect(()=>admitted.restore([])).toThrow(/lost/);
 });
});

it("retains a runtime detail between source chunks through the official log buffering, with exact position provenance", () => {
 const input = [
  {type:"turn/start",data:{turn:1}},{type:"step/start",data:{turn:1,step:1}},
  {type:"assistant/chunk",data:{turn:1,step:1,chunk:{type:"text-delta",index:0,text:"hello"}}},
  {type:"dsh-runtime/detail",data:{id:"mid-stream-card",items:[],state:"running"}},
  {type:"assistant/chunk",data:{turn:1,step:1,chunk:{type:"finish",reason:{kind:"stop"}}}},
  {type:"assistant/message",data:{turn:1,step:1,message:{id:"assistant",role:"assistant",source:{kind:"model",provider:"mock",model:"mock"},content:[{type:"text",text:"hello"}]}},sourceEventSeqs:[2,4],surfaceOp:"append"},
  {type:"step/end",data:{turn:1,step:1}},{type:"turn/end",data:{turn:1,reason:{kind:"completed"}}},
 ].map((event,seq)=>({...event,seq,time:seq+1}));
 const before=JSON.stringify(input), converted=migrateLegacy({...artifact,header:{...artifact.header,version:1},events:input});
 const card=converted.artifact.events.find(e=>e.type==="dsh-runtime/detail")!;
 expect(card).toEqual({...input[3],seq:card.seq,ignorable:true});
 expect(converted.ledger.seqMap[3]).toEqual([card.seq]);
 expect(converted.ledger.informationalPositions).toEqual([{sourceSeq:3,targetSeq:card.seq}]);
 expect(converted.artifact.events.some(e=>e.type==="feedback/record")).toBe(false);
 expect(visibleContext(converted.artifact)).toEqual(expect.arrayContaining([expect.objectContaining({id:"assistant",content:[{type:"text",text:"hello"}]})]));
 expect(JSON.stringify(input)).toBe(before);
});

it("retains official V0 normalization of flat assistant and tool-result envelopes", () => {
 const input = [
  {type:"turn/start",data:{turn:1}},{type:"step/start",data:{turn:1,step:1}},
  {type:"assistant/message",data:{turn:1,step:1,content:[{type:"tool-call",id:"call",name:"read",arguments:"{}"}],provenance:{provider:"mock",model:"mock"}},surfaceOp:"append"},
  {type:"tool/call",data:{turn:1,step:1,callId:"call",name:"read",arguments:"{}"}},
  {type:"tool/result",data:{turn:1,step:1,callId:"call",content:[{type:"text",text:"fixture output"}],isError:false},surfaceOp:"append"},
  {type:"step/end",data:{turn:1,step:1}},{type:"turn/end",data:{turn:1,reason:{kind:"completed"}}},
 ].map((event,seq)=>({...event,seq,time:seq+1}));
 const {isSeeded,...header}=artifact.header;
 const reader=sessionFormatCatalog.createRestore({type:"session",...header},{recovery:"strict",validation:"current"});
 for(const e of input)reader.decodeRow(e);
 expect(migrateLegacy({...artifact,events:input}).artifact).toEqual(reader.finish());
 const malformed=input.map(e=>e.type==="tool/result"?{...e,data:{turn:1,step:1,message:null}}:e);
 expect(()=>migrateLegacy({...artifact,events:malformed})).toThrow();
});
