import { createHash } from "node:crypto";
import { foldSurface } from "@deepseek-ai/dsh-session/surface";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { SessionFormatArtifact, SessionFormatEvent } from "@deepseek-ai/dsh-session-format";
import {
  nativeContextMaterialInputSchema, type JsonValue, type NativeContextMaterialInput,
  type NativeContextMaterialsEvidenceInput, type NativeContextReleaseEvidenceInput, type NativeContextReleaseEvidence,
} from "@linmu/dsh-session-contracts";
import { count, record, isRecord, type Obj } from "./common.js";
import { validateV3 } from "./official.js";

const plugin = "dsh-annotation-core";
const marker = (id: string) => `[Released context ${id}; source position is retained. Read again only when needed.]`;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
/** Same escaped canonical JSON protocol as Annotation Core, including <>&. */
function serialized(value: unknown): string {
  return JSON.stringify(canonical(value)).replace(/[<>&\u2028\u2029]/gu, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
const sha = (value: unknown) => `sha256:${createHash("sha256").update(serialized(value)).digest("hex")}`;
const size = (value: unknown) => Buffer.byteLength(typeof value === "string" ? value : serialized(value));
const equal = (a: unknown, b: unknown) => serialized(a) === serialized(b);
const reject = (message: string): never => { throw new TypeError(`Native context evidence: ${message}`); };
function strings(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item || item.length > 256)) return reject("invalid identity list");
  return [...value] as string[];
}
function onlyText(value: JsonValue | undefined): string {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0]) || value[0].type !== "text" || typeof value[0].text !== "string")
    return reject("unsupported text envelope");
  return value[0].text;
}
function toolValue(event: SessionFormatEvent): Obj {
  const data = record(event.data), message = record(data.message);
  if (!Array.isArray(message.content) || message.content.length !== 1) return reject("unsupported tool result shape");
  const result = record(message.content[0]);
  if (result.isError === true) return reject("failed tool result is not releasable context");
  return record(JSON.parse(onlyText(result.content)));
}
function annotationValue(event: SessionFormatEvent): { annotations: Obj[]; documents: Obj[] } {
  const data = record(event.data);
  const text = Array.isArray(data.content) ? data.content.map(value => isRecord(value) && value.type === "text" && typeof value.text === "string" ? value.text : "").join("") : "";
  const match = /^<dsh-annotations version="1" set-id="[^"]*">\n([^\n]*)\n<\/dsh-annotations>\n<dsh-reference-documents>\n([^\n]*)\n<\/dsh-reference-documents>$/.exec(text);
  if (!match) return reject("invalid annotation envelope");
  const annotation = record(JSON.parse(match[1]!)), documents = record(JSON.parse(match[2]!));
  if (!Array.isArray(annotation.items) || !Array.isArray(documents.documents)) return reject("invalid annotation collections");
  return { annotations: annotation.items.map(item => record(item)), documents: documents.documents.map(item => record(item)) };
}
interface Part { key: string; material: NativeContextMaterialInput }
function part(nativeSessionId: string, event: SessionFormatEvent, key: string, kind: NativeContextMaterialInput["kind"], referenceIds: string[], content: unknown,
  ranges: NativeContextMaterialInput["ranges"]): Part {
  return { key, material: nativeContextMaterialInputSchema.parse({ materialId: `ncm:${sha([nativeSessionId, event.seq, key]).slice(7)}`,
    eventSeq: event.seq, kind, referenceIds, contentHash: sha(content), bytes: size(content), ranges, sourceEventSeqs: [event.seq] }) };
}
function parts(nativeSessionId: string, event: SessionFormatEvent): Part[] {
  if (event.surfaceOp !== "append") return reject("material is not an original append event");
  const data = record(event.data);
  if (event.type === "user/message") {
    const source = record(data.source);
    if (source.kind !== "dsh-annotation" || source.schemaVersion !== 1 || typeof source.setId !== "string") return reject("user source is not an attested annotation");
    const { annotations, documents } = annotationValue(event);
    if (sha({ schemaVersion: 1, setId: source.setId, annotations, documents }) !== source.digest) return reject("annotation digest mismatch");
    const authorityIds = new Map(annotations.map(item => {
      const itemId = strings([item.referenceId!])[0]!, locator = isRecord(item.locator) ? item.locator : {};
      const upstream = isRecord(locator.upstream) ? locator.upstream : {};
      const authority = item.sourceType === "dsh-message" && upstream.referenceId !== undefined ? strings([upstream.referenceId])[0]! : itemId;
      return [itemId, authority];
    }));
    const result: Part[] = [];
    for (const item of annotations) {
      const itemId = strings([item.referenceId!])[0]!, referenceIds = [authorityIds.get(itemId)!];
      const { initialContext } = item;
      result.push(part(nativeSessionId, event, `reference:${itemId}`, "initial", referenceIds, item.selectedText, []));
      if (initialContext !== undefined) {
        const initial = record(initialContext);
        if (!Array.isArray(initial.items)) return reject("invalid initial context items");
        for (const [index, value] of initial.items.entries()) {
          const range = record(value), start = count(range.offset);
          if (typeof range.text !== "string" || typeof range.eventId !== "string") return reject("invalid initial context range");
          result.push(part(nativeSessionId, event, `reference:${itemId}:item:${index}`, "initial", referenceIds, range,
            [{ referenceId: referenceIds[0]!, eventId: range.eventId, start, end: start + range.text.length }]));
        }
      }
    }
    for (const document of documents) {
      if (typeof document.key !== "string" || typeof document.markdown !== "string") return reject("invalid reference document");
      result.push(part(nativeSessionId, event, `document:${document.key}`, "initial",
        [...new Set(strings(document.referenceIds).map(id => authorityIds.get(id) ?? id))], document.markdown, []));
    }
    return result;
  }
  if (event.type !== "tool/result") return reject("event does not contain managed context");
  const presentation = isRecord(data.presentationMeta) ? data.presentationMeta : isRecord(data.meta) ? data.meta : {};
  const meta = record(presentation.nativeContext);
  if (meta.protocolVersion !== 1 || meta.plugin !== plugin || !["read", "search", "requests"].includes(String(meta.kind))) return reject("tool result lacks trusted context metadata");
  const kind = meta.kind as "read" | "search" | "requests", referenceIds = strings(meta.referenceIds), value = toolValue(event);
  if (!Array.isArray(value.items)) {
    const messageContent = record(data.message).content;
    if (!Array.isArray(messageContent)) return reject("invalid tool message content");
    const content = record(messageContent[0]).content;
    return [part(nativeSessionId, event, "tool-result", kind, referenceIds, content, meta.ranges as NativeContextMaterialInput["ranges"])];
  }
  return value.items.map((value, index) => {
    const item = record(value), eventId = typeof item.eventId === "string" ? item.eventId : typeof item.requestId === "string" ? item.requestId : undefined;
    const start = Number.isSafeInteger(item.textOffset) && kind === "requests" ? Number(item.textOffset) : Number.isSafeInteger(item.offset) ? Number(item.offset) : 0;
    const text = typeof item.text === "string" ? item.text : typeof item.excerpt === "string" ? item.excerpt : "";
    const ranges = eventId ? referenceIds.map(referenceId => ({ referenceId, eventId, start, end: start + (kind === "requests" ? [...text].length : text.length) })) : [];
    return part(nativeSessionId, event, `tool:item:${index}`, kind, referenceIds, item, ranges);
  });
}
interface Proof { protocolVersion: 1; plugin: string; operationIds: string[]; materialIds: string[]; originalEventSeq: number }
function proof(event: SessionFormatEvent): Proof | undefined {
  if (!isRecord(event.surfaceOp) || event.surfaceOp.op !== "replace") return undefined;
  let value: Obj;
  try {
    value = event.type === "tool/result" ? record(toolValue(event).nativeContextRelease)
      : event.type === "user/message" ? record(record(event.data).source) : {};
  } catch { return undefined; }
  if (value.protocolVersion !== 1 || value.plugin !== plugin || !Number.isSafeInteger(value.originalEventSeq)
    || (event.type === "user/message" && value.kind !== "dsh-native-context-release")) return undefined;
  return { protocolVersion: 1, plugin, operationIds: strings(value.operationIds), materialIds: strings(value.materialIds), originalEventSeq: Number(value.originalEventSeq) };
}
function artifact(payload: JsonValue, nativeSessionId: string) {
  const value = record(payload), header = record(value.header);
  if (header.id !== nativeSessionId) return reject("native session identity mismatch");
  if (!Array.isArray(value.events)) return reject("missing persisted event log");
  const native = validateV3({ header: value.header, events: value.events, inheritedEventCount: value.inheritedEventCount ?? 0 } as unknown as SessionFormatArtifact);
  const surface = foldSurface(native.events as readonly SessionEvent[]);
  return { events: native.events, surface };
}
function verifyMaterials(nativeSessionId: string, events: readonly SessionFormatEvent[], expected: readonly NativeContextMaterialInput[]): Part[] {
  const result: Part[] = [], cache = new Map<number, Part[]>();
  for (const raw of expected) {
    // Engine records add lifecycle/pin fields to the same immutable material.
    // Only the attested input fields belong to the native evidence comparison.
    const { materialId, eventSeq, referenceIds, kind, bytes, contentHash, ranges, sourceEventSeqs } = raw;
    const wanted = nativeContextMaterialInputSchema.parse({ materialId, eventSeq, referenceIds, kind, bytes, contentHash, ranges,
      ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }) });
    const event = events.find(event => event.seq === wanted.eventSeq);
    if (!event) return reject("material source has not reached durable history");
    let available = cache.get(wanted.eventSeq);
    if (!available) { available = parts(nativeSessionId, event); cache.set(wanted.eventSeq, available); }
    const found = available.find(part => part.material.materialId === wanted.materialId);
    if (!found || !equal(found.material, { ...wanted, sourceEventSeqs: wanted.sourceEventSeqs ?? [wanted.eventSeq] })) return reject("material identity, hash or source range mismatch");
    result.push(found);
  }
  return result;
}

export function verifyV3NativeContextMaterials(payload: JsonValue, input: NativeContextMaterialsEvidenceInput): readonly NativeContextMaterialInput[] {
  const native = artifact(payload, input.nativeSessionId);
  return verifyMaterials(input.nativeSessionId, native.events, input.materials).map(part => part.material);
}

function validateReplacement(nativeSessionId: string, original: SessionFormatEvent, replacement: SessionFormatEvent, markerProof: Proof): void {
  const operation = record(replacement.surfaceOp);
  if (operation.startSeq !== operation.endSeq || !Array.isArray(replacement.sourceEventSeqs)
    || !replacement.sourceEventSeqs.includes(original.seq) || !replacement.sourceEventSeqs.includes(operation.startSeq!))
    return reject("replacement lacks a one-node source chain");
  const all = parts(nativeSessionId, original), released = new Map(all.filter(part => markerProof.materialIds.includes(part.material.materialId)).map(part => [part.key, part.material.materialId]));
  if (released.size !== new Set(markerProof.materialIds).size) return reject("replacement names an unknown material");
  if (original.type !== replacement.type) return reject("replacement changed native message type");
  const originalData = record(original.data), replacementData = record(replacement.data);
  if (original.type === "tool/result") {
    const value = toolValue(original), actual = toolValue(replacement);
    const revised = Array.isArray(value.items) ? { ...value, items: value.items.map((value, index) => {
      const id = released.get(`tool:item:${index}`), item = record(value);
      if (!id) return item;
      const retained = Object.fromEntries(Object.entries(item).filter(([key]) => ["eventId", "requestId", "logicalSessionId", "sourceVersionId", "role", "offset", "textOffset", "complete", "ordinal", "createdAt", "turnId", "turnBoundaryEventId", "relation", "state", "associationState"].includes(key)));
      return { ...retained, text: marker(id), released: true };
    }) } : { message: "Source positions retained; read again only when needed." };
    if (!equal(actual, { ...revised, nativeContextRelease: markerProof })) return reject("tool replacement did not release only the declared items");
    // Official foldSurface already validates every tool-result field except
    // content, including protocol pairing, meta, source and call identity.
    return;
  }
  const parsed = annotationValue(original), actual = annotationValue(replacement);
  const annotations = parsed.annotations.map(item => {
    const id = released.get(`reference:${String(item.referenceId)}`), initial = item.initialContext === undefined ? undefined : record(item.initialContext);
    const initialContext = initial ? { ...initial, items: (initial.items as JsonValue[]).map((value, index) => {
      const range = record(value), partId = released.get(`reference:${String(item.referenceId)}:item:${index}`);
      return partId ? { ...range, text: marker(partId), released: true } : range;
    }) } : undefined;
    return { ...item, ...(id ? { selectedText: marker(id) } : {}), ...(initialContext ? { initialContext } : {}) };
  });
  const documents = parsed.documents.map(document => {
    const id = released.get(`document:${String(document.key)}`); return id ? { ...document, markdown: marker(id) } : document;
  });
  if (!equal(actual, { annotations, documents })) return reject("annotation replacement changed retained materials");
  const { content: ignoredOriginal, source, ...rest } = originalData;
  const { content: ignoredReplacement, source: actualSource, ...actualRest } = replacementData;
  void ignoredOriginal; void ignoredReplacement;
  const originalSource = record(source);
  if (!equal(rest, actualRest) || !equal(actualSource, { kind: "dsh-native-context-release", ...markerProof,
    setId: originalSource.setId, targetUserMessageId: originalSource.targetUserMessageId })) return reject("annotation replacement changed user identity or source proof");
}

export function verifyV3NativeContextRelease(payload: JsonValue, input: NativeContextReleaseEvidenceInput): NativeContextReleaseEvidence {
  const native = artifact(payload, input.nativeSessionId), expected = verifyMaterials(input.nativeSessionId, native.events, input.materials);
  if (expected.length === 0 || new Set(expected.map(part => part.material.materialId)).size !== expected.length) return reject("release must name distinct durable materials");
  const roots = [...new Set(expected.map(part => part.material.eventSeq))].sort((a, b) => a - b), surfaceEventSeqs: number[] = [];
  let releasedBytes = 0;
  for (const root of roots) {
    const original = native.events.find(event => event.seq === root)!;
    const wantedIds = expected.filter(part => part.material.eventSeq === root).map(part => part.material.materialId);
    const current = native.surface.nodes.map(seq => native.events.find(event => event.seq === seq)!).filter(event => proof(event)?.originalEventSeq === root);
    if (current.length !== 1 || native.surface.nodes.includes(root as never)) return reject("no unique applied replacement on the current surface");
    const replacement = current[0]!, markerProof = proof(replacement)!;
    if (!markerProof.operationIds.includes(input.operationId) || wantedIds.some(id => !markerProof.materialIds.includes(id))) return reject("current surface does not attest the operation's materials");
    let link = replacement;
    while (link.seq !== original.seq) {
      const linkedProof = proof(link);
      if (!linkedProof || linkedProof.originalEventSeq !== root) return reject("unsupported external compaction in the source chain");
      validateReplacement(input.nativeSessionId, original, link, linkedProof);
      const previous = native.events.find(event => event.seq === record(link.surfaceOp).startSeq);
      if (!previous || previous.seq >= link.seq || previous.seq < original.seq) return reject("invalid replacement source chain");
      link = previous;
    }
    surfaceEventSeqs.push(replacement.seq);
    // A later release may replace this same node again. Charge only this
    // operation's first verified transition, not every earlier released byte.
    const transition = native.events.find(event => {
      const evidence = proof(event); return evidence?.originalEventSeq === root && evidence.operationIds.includes(input.operationId)
        && wantedIds.every(id => evidence.materialIds.includes(id));
    });
    if (!transition) return reject("missing durable replacement transition");
    validateReplacement(input.nativeSessionId, original, transition, proof(transition)!);
    const previous = native.events.find(event => event.seq === record(transition.surfaceOp).startSeq);
    if (!previous) return reject("missing prior surface node");
    releasedBytes += Math.max(0, size(previous.data) - size(transition.data));
  }
  surfaceEventSeqs.sort((a, b) => a - b);
  if (input.sourceEventSeqs && !equal([...new Set(input.sourceEventSeqs)].sort((a, b) => a - b), roots)) return reject("claimed source events differ from the persisted proof");
  if (input.surfaceEventSeqs && !equal([...new Set(input.surfaceEventSeqs)].sort((a, b) => a - b), surfaceEventSeqs)) return reject("claimed surface events differ from the current persisted surface");
  const value = { schemaVersion: 1 as const, sourceEventSeqs: roots, surfaceEventSeqs,
    materialIds: expected.map(part => part.material.materialId).sort(), releasedBytes };
  return { ...value, proofDigest: sha([input.nativeSessionId, input.operationId, value]) };
}
