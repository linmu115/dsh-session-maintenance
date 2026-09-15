import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { JsonValue, NativeContextMaterialInput } from "@linmu/dsh-session-contracts";
import { verifyV3NativeContextMaterials, verifyV3NativeContextRelease } from "../src/native-context-evidence.js";
import { contextHeader } from "./context-fixture.js";

function canonical(value: any): string {
  const sorted = (v: any): any => Array.isArray(v) ? v.map(sorted) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map(key => [key, sorted(v[key])])) : v;
  return JSON.stringify(sorted(value)).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
const hash = (value: unknown) => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
const nativeSessionId = "source-native", operationId = "release-test";
const released = (id: string) => `[Released context ${id}; source position is retained. Read again only when needed.]`;
const evidence = (materialIds: string[], originalEventSeq = 0, operations = [operationId]) => ({ protocolVersion: 1, plugin: "dsh-annotation-core", materialIds, operationIds: operations, originalEventSeq });
const event = (seq: number, type: string, data: any, surfaceOp: any = "append", sourceEventSeqs?: number[]): any =>
  ({ seq, time: seq + 1, type, data, surfaceOp, ...(sourceEventSeqs ? { sourceEventSeqs } : {}) });
const payload = (events: any[]): JsonValue => ({ header: contextHeader, inheritedEventCount: 0, events }) as never;
function material(key: string, content: any, extra: Partial<NativeContextMaterialInput> = {}): NativeContextMaterialInput {
  return { materialId: `ncm:${hash([nativeSessionId, extra.eventSeq ?? 0, key]).slice(7)}`, eventSeq: 0, referenceIds: ["ref-A"], kind: "read",
    contentHash: hash(content), bytes: Buffer.byteLength(typeof content === "string" ? content : canonical(content)),
    ranges: [], sourceEventSeqs: [0], ...extra };
}
function toolFixture() {
  const prefix = [
    { seq: 0, time: 1, type: "turn/start", data: { turn: 1 } },
    { seq: 1, time: 2, type: "step/start", data: { turn: 1, step: 1 } },
    event(2, "assistant/message", { turn: 1, step: 1, message: { id: "assistant-call", role: "assistant", source: { kind: "model", provider: "fixture", model: "fixture" },
      content: [{ type: "tool-call", id: "call-1", name: "dsh_upstream_read", arguments: "{}" }] }, stream: [] }),
    { seq: 3, time: 4, type: "tool/call", data: { turn: 1, step: 1, callId: "call-1", name: "dsh_upstream_read", arguments: "{}" } },
  ];
  const items = [35, 38, 40].map(n => ({ eventId: `reply-${n}`, role: "assistant", text: `<body-${n} & 😀> `.repeat(90), offset: 0, complete: true }));
  const value = { referenceId: "ref-A", sourceVersionId: "fixed", nextCursor: "earlier", items };
  const source = event(4, "tool/result", { turn: 1, step: 1,
    meta: { nativeContext: { protocolVersion: 1, plugin: "dsh-annotation-core", kind: "read", referenceIds: ["ref-A"], ranges: [] } },
    message: { id: "tool-result-id", role: "user", source: { kind: "tool", callId: "call-1" }, content: [{ type: "tool-result", toolCallId: "call-1", isError: false,
      content: [{ type: "text", text: canonical(value) }] }] } });
  const materials = items.map((item, index) => material(`tool:item:${index}`, item,
    { eventSeq: 4, sourceEventSeqs: [4], ranges: [{ referenceId: "ref-A", eventId: item.eventId, start: 0, end: item.text.length }] }));
  const replace = (ids: string[], seq = 5, startSeq = 4, operations = [operationId]) => {
    const updated = { ...value, items: items.map((item, i) => ids.includes(materials[i]!.materialId)
      ? { eventId: item.eventId, role: item.role, offset: 0, complete: true, text: released(materials[i]!.materialId), released: true } : item),
      nativeContextRelease: evidence(ids, 4, operations) };
    const data = structuredClone(source.data); data.message.content[0].content = [{ type: "text", text: canonical(updated) }];
    return event(seq, "tool/result", data, { op: "replace", startSeq, endSeq: startSeq }, [...new Set([startSeq, 4])]);
  };
  return { source, materials, replace, items, log: (...events: any[]) => payload([...prefix, ...events]) };
}

describe("durable native context release evidence", () => {
  it("verifies actual partial tool replacement, fixed pairing, Unicode hashes and retained sibling items", () => {
    const f = toolFixture(), target = f.materials[0]!, next = f.replace([target.materialId]), original = f.log(f.source, next);
    const before = canonical(original);
    expect(verifyV3NativeContextMaterials(original, { nativeSessionId, materials: f.materials })).toEqual(f.materials);
    const proof = verifyV3NativeContextRelease(original, { nativeSessionId, operationId, materials: [target], sourceEventSeqs: [4], surfaceEventSeqs: [5] });
    expect(proof).toMatchObject({ schemaVersion: 1, sourceEventSeqs: [4], surfaceEventSeqs: [5], materialIds: [target.materialId] });
    expect(proof.releasedBytes).toBeGreaterThan(0);
    expect(proof.proofDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(canonical(original)).toBe(before);
  });
  it("rejects a host claim with no replacement, stale surface, modified sibling or wrong material hash", () => {
    const f = toolFixture(), target = f.materials[0]!, next = f.replace([target.materialId]);
    expect(() => verifyV3NativeContextRelease(f.log(f.source), { nativeSessionId, operationId, materials: [target] })).toThrow("applied replacement");
    expect(() => verifyV3NativeContextRelease(f.log(f.source, next), { nativeSessionId, operationId: "another-op", materials: [target] })).toThrow("attest");
    expect(() => verifyV3NativeContextMaterials(f.log(f.source), { nativeSessionId, materials: [{ ...target, contentHash: "sha256:forged" }] })).toThrow("hash");
    expect(() => verifyV3NativeContextRelease(f.log(f.source, next), { nativeSessionId, operationId, materials: [target], surfaceEventSeqs: [4] })).toThrow("claimed surface");
    const tampered = structuredClone(next), value = JSON.parse(tampered.data.message.content[0].content[0].text);
    value.items[1].text = "sibling was erased"; tampered.data.message.content[0].content[0].text = canonical(value);
    expect(() => verifyV3NativeContextRelease(f.log(f.source, tampered), { nativeSessionId, operationId, materials: [target] })).toThrow("declared items");
  });
  it("checks protocol call identity through DSH's own surface validator", () => {
    const f = toolFixture(), next = f.replace([f.materials[0]!.materialId]);
    next.data.message.content[0].toolCallId = "foreign-call";
    expect(() => verifyV3NativeContextRelease(f.log(f.source, next), { nativeSessionId, operationId, materials: [f.materials[0]!] })).toThrow();
  });
  it("verifies a released request-index page with its retained codepoint textOffset", () => {
    const f = toolFixture();
    const item = { requestId: "request-user-1", eventId: "user-event-1", text: "后续请求😀".repeat(90), textOffset: 384,
      ordinal: 1, state: "completed", nextTextCursor: "next-user-text-page" };
    const source = structuredClone(f.source);
    source.data.meta.nativeContext.kind = "requests";
    const value = { referenceId: "ref-A", directoryOnly: true, items: [item], nextCursor: "next-directory-page" };
    source.data.message.content[0].content[0].text = canonical(value);
    const wanted = material("tool:item:0", item, { eventSeq: 4, sourceEventSeqs: [4], kind: "requests",
      ranges: [{ referenceId: "ref-A", eventId: item.eventId, start: item.textOffset, end: item.textOffset + Array.from(item.text).length }] });
    const data = structuredClone(source.data);
    data.message.content[0].content[0].text = canonical({ ...value,
      items: [{ requestId: item.requestId, eventId: item.eventId, ordinal: item.ordinal, state: item.state,
        textOffset: item.textOffset, text: released(wanted.materialId), released: true }],
      nativeContextRelease: evidence([wanted.materialId], 4) });
    const replacement = event(5, "tool/result", data, { op: "replace", startSeq: 4, endSeq: 4 }, [4]);
    expect(verifyV3NativeContextMaterials(f.log(source, replacement), { nativeSessionId, materials: [wanted] })).toEqual([wanted]);
    expect(verifyV3NativeContextRelease(f.log(source, replacement), { nativeSessionId, operationId, materials: [wanted] }).releasedBytes).toBeGreaterThan(0);
  });
  it("uses the current surface after a second release and recovers the original operation byte delta", () => {
    const f = toolFixture(), first = f.replace([f.materials[0]!.materialId]);
    const second = f.replace([f.materials[0]!.materialId, f.materials[1]!.materialId], 6, 5, [operationId, "release-second"]);
    const before = verifyV3NativeContextRelease(f.log(f.source, first), { nativeSessionId, operationId, materials: [f.materials[0]!] });
    const after = verifyV3NativeContextRelease(f.log(f.source, first, second), { nativeSessionId, operationId, materials: [f.materials[0]!] });
    expect(after.surfaceEventSeqs).toEqual([6]);
    expect(after.releasedBytes).toBe(before.releasedBytes);
    expect(() => verifyV3NativeContextRelease(f.log(f.source, first, second), { nativeSessionId, operationId, materials: [f.materials[0]!], surfaceEventSeqs: [5] })).toThrow("current persisted surface");
  });
  it("verifies one initial fragment without erasing user comment, descriptor, other fragment or shared document", () => {
    const initial = [{ eventId: "question", role: "user", text: "question context", offset: 0, complete: true },
      { eventId: "answer", role: "assistant", text: "large answer text😀 ".repeat(150), offset: 0, complete: true }];
    const annotations = [{ referenceId: "ui-ref-A", sourceType: "dsh-message", locator: { upstream: { referenceId: "ref-A" } },
      selectedText: "selected snippet", userComment: "ACTUAL USER REQUEST: compare this carefully", initialContext: { items: initial } }];
    const documents = [{ key: "doc", referenceIds: ["ui-ref-A", "ref-B"], markdown: "shared document" }];
    const text = (a: any) => `<dsh-annotations version="1" set-id="set">\n${canonical({ items: a })}\n</dsh-annotations>\n<dsh-reference-documents>\n${canonical({ documents })}\n</dsh-reference-documents>`;
    const source = event(0, "user/message", { id: "annotation-envelope", role: "user", source: { kind: "dsh-annotation", schemaVersion: 1, setId: "set", count: 1,
      targetUserMessageId: "user-real", digest: hash({ schemaVersion: 1, setId: "set", annotations, documents }) }, content: [{ type: "text", text: text(annotations) }] });
    const target = material("reference:ui-ref-A:item:1", initial[1], { kind: "initial", ranges: [{ referenceId: "ref-A", eventId: "answer", start: 0, end: initial[1]!.text.length }] });
    const descriptor = material("reference:ui-ref-A", "selected snippet", { kind: "initial" });
    const document = material("document:doc", "shared document", { kind: "initial", referenceIds: ["ref-A", "ref-B"] });
    expect(verifyV3NativeContextMaterials(payload([source]), { nativeSessionId, materials: [target, descriptor, document] })).toEqual([target, descriptor, document]);
    const altered = [{ ...annotations[0], initialContext: { items: [initial[0], { ...initial[1], text: released(target.materialId), released: true }] } }];
    const next = event(1, "user/message", { ...source.data, content: [{ type: "text", text: text(altered) }],
      source: { kind: "dsh-native-context-release", ...evidence([target.materialId]), setId: "set", targetUserMessageId: "user-real" } }, { op: "replace", startSeq: 0, endSeq: 0 }, [0]);
    expect(verifyV3NativeContextRelease(payload([source, next]), { nativeSessionId, operationId, materials: [target] }).releasedBytes).toBeGreaterThan(0);
    const broken = structuredClone(next); altered[0]!.userComment = ""; broken.data.content[0].text = text(altered);
    expect(() => verifyV3NativeContextRelease(payload([source, broken]), { nativeSessionId, operationId, materials: [target] })).toThrow("retained materials");
    const fake = structuredClone(source); fake.data.source.kind = "user";
    expect(() => verifyV3NativeContextMaterials(payload([fake]), { nativeSessionId, materials: [target] })).toThrow("attested annotation");
  });
  it("rejects restoring material previously removed by an unrelated native compactor", () => {
    const f = toolFixture(), pruned = structuredClone(f.source);
    pruned.seq = 5; pruned.time = 6; pruned.surfaceOp = { op: "replace", startSeq: 4, endSeq: 4 }; pruned.sourceEventSeqs = [4];
    pruned.data.message.content[0].content = [{ type: "text", text: "native pruner removed these bodies" }];
    const next = f.replace([f.materials[0]!.materialId], 6, 5);
    expect(() => verifyV3NativeContextRelease(f.log(f.source, pruned, next), { nativeSessionId, operationId, materials: [f.materials[0]!] })).toThrow("external compaction");
  });
});
