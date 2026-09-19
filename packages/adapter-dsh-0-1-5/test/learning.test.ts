import { expect, it } from "vitest";
import { learningMessagesFromV3 } from "../src/learning.js";
it("carries reference snapshots as context while omitting tool calls and extension objects", () => {
  const artifact = { events: [
    { type: "user/message", seq: 0, data: { id: "u", content: [{ type: "text", text: "Explain the quote" }] } },
    { type: "assistant/message", seq: 1, data: { message: { id: "call", content: [{ type: "tool-call", name: "dsh_upstream_read", id: "t", arguments: "{}" }] } } },
    { type: "tool/result", seq: 2, data: { meta: { nativeContext: { kind: "read" } }, message: { content: [{ type: "tool-result", content: [{ type: "text", text: '引用原文、来源与固定版本' }] }] } } },
    { type: "other", seq: 3, data: { graph: "extension-object-secret" } },
    { type: "assistant/message", seq: 4, data: { message: { id: "a", content: [{ type: "text", text: "Explanation" }] } } },
  ] } as never;
  const result = learningMessagesFromV3(artifact);
  expect(result.map(m => m.text)).toEqual(["Explain the quote", "[引用上下文快照]\n引用原文、来源与固定版本", "Explanation"]);
  expect(JSON.stringify(result)).not.toContain("extension-object-secret");
});
it("skips images without changing text, dropping image-only turns or mutating source history", () => {
  const artifact={events:[
    {type:'user/message',data:{id:'u',content:[{type:'text',text:'  question'},{type:'image',url:'private-image'},{type:'text',text:'details\n'}]}},
    {type:'assistant/message',data:{message:{id:'a',content:[{type:'text',text:'answer'}]}}},
    {type:'user/message',data:{id:'image-only',content:[{type:'image',url:'private-image'}]}},
    {type:'tool/result',seq:3,data:{meta:{nativeContext:{}},message:{content:[{type:'tool-result',content:[{type:'image',url:'private-context-image'}]}]}}},
  ]} as never;
  const before=JSON.stringify(artifact),result=learningMessagesFromV3(artifact);
  expect(result.map(m=>m.text)).toEqual(['  question\ndetails\n','answer','[图片已跳过]','[引用上下文快照]\n[图片已跳过]']);
  expect(result.map(m=>m.skippedImages??0)).toEqual([1,0,1,1]);
  expect(JSON.stringify(result)).not.toContain('private-image');expect(JSON.stringify(artifact)).toBe(before);
});
it("still rejects files and unknown nontext content", () => {
  expect(() => learningMessagesFromV3({ events: [{ type: "user/message", data: { content: [{ type: "file", url: "fixture" }] } }] } as never)).toThrow("非文本材料");
});
