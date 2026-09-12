import { createHash } from "node:crypto";
import type { CanonicalEventV1, JsonValue } from "@linmu/dsh-session-contracts";
import { isRecord, record, type Obj } from "./common.js";

export interface PortableAttachment { readonly ref: Obj; readonly kind: "image" | "file"; readonly base64: string }
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const positive = (n: number) => { if (!Number.isSafeInteger(n) || n < 1) throw new TypeError("Invalid image dimensions"); return n; };

/** Decode container dimensions without transcoding or changing the original attachment bytes. */
export function imageDimensions(bytes: Buffer, mediaType: string): {width: number; height: number} {
 let width = 0, height = 0;
 if (mediaType === "image/png" && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.length >= 24) {
  width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
 } else if (mediaType === "image/gif" && /^GIF8[79]a$/.test(bytes.subarray(0,6).toString()) && bytes.length >= 10) {
  width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8);
 } else if (mediaType === "image/webp" && bytes.subarray(0,4).toString() === "RIFF" && bytes.subarray(8,12).toString() === "WEBP") {
  const chunk = bytes.subarray(12,16).toString();
  if (chunk === "VP8X" && bytes.length >= 30) { width = bytes.readUIntLE(24,3)+1; height = bytes.readUIntLE(27,3)+1; }
  else if (chunk === "VP8 " && bytes.length >= 30 && bytes.subarray(23,26).equals(Buffer.from([157,1,42]))) { width = bytes.readUInt16LE(26)&16383; height = bytes.readUInt16LE(28)&16383; }
  else if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 47) { const bits = bytes.readUInt32LE(21); width = (bits&16383)+1; height = ((bits>>>14)&16383)+1; }
 } else if (mediaType === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) {
  let orientation = 1;
  for (let at = 2; at+4 <= bytes.length;) {
   if (bytes[at++] !== 255) throw new TypeError("Invalid JPEG segment");
   while (bytes[at] === 255) at++;
   const marker = bytes[at++]!; if (marker === 217 || marker === 218) break;
   if (marker === 1 || marker >= 208 && marker <= 215) continue;
   const length = bytes.readUInt16BE(at); if (length < 2 || at+length > bytes.length) throw new TypeError("Truncated JPEG segment");
   if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 7) { height = bytes.readUInt16BE(at+3); width = bytes.readUInt16BE(at+5); }
   if (marker === 225 && bytes.subarray(at+2,at+8).toString() === "Exif\0\0") {
    const t = bytes.subarray(at+8,at+length), little = t.subarray(0,2).toString() === "II";
    const u16 = (n:number) => little ? t.readUInt16LE(n) : t.readUInt16BE(n);
    const u32 = (n:number) => little ? t.readUInt32LE(n) : t.readUInt32BE(n);
    if (t.length >= 8) { const off=u32(4); if (off+2 <= t.length) for(let i=0,n=u16(off);i<n;i++) {const e=off+2+i*12;if(e+12>t.length)throw new TypeError("Truncated EXIF");if(u16(e)===274&&u16(e+2)===3&&u32(e+4)===1)orientation=u16(e+8);}}
   }
   at += length;
  }
  if (orientation >= 5 && orientation <= 8) [width,height]=[height,width];
 }
 return {width:positive(width),height:positive(height)};
}

export function messageRecord(event: CanonicalEventV1): Obj { return isRecord(event.content) ? isRecord(event.content.message) ? event.content.message : event.content : {}; }
export function messageIdentity(event: CanonicalEventV1): string { const id=messageRecord(event).id; return typeof id === "string" && id.length ? id : event.id; }
function safeName(value: unknown): string { const s=typeof value === "string" ? value : "file"; const leaf=s.split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f<>:"|?*]/g,"_").replace(/[. ]+$/g,""); return !leaf || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(leaf) ? `_${leaf || "file"}` : leaf; }
export function portableContent(event: CanonicalEventV1, attachments: Map<string, PortableAttachment>): JsonValue[] {
 const message=messageRecord(event);
 const blocks: JsonValue[] = Array.isArray(message.content) ? structuredClone(message.content) : typeof event.content === "string" ? [{type:"text",text:event.content}] : typeof message.text === "string" ? [{type:"text",text:message.text}] : [];
 // A source with a content array already defines order; appending a second attachment list would guess it.
 if (Array.isArray(message.content) && Array.isArray(message.attachments) && message.attachments.length) throw new TypeError("Ambiguous parallel content and attachments");
 for (const value of Array.isArray(message.attachments) ? message.attachments : []) {
  const a=record(value), source=a.source ?? a.url;
  if (typeof source !== "string") throw new TypeError("Portable attachment has no immutable source");
  const match=/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(source);
  if (!match) throw new TypeError("Portable attachment needs an explicit external-resource resolver");
  const data=Buffer.from(match[2]!,"base64"); if (!data.length || data.toString("base64") !== match[2]!.replace(/[\r\n]/g,"")) throw new TypeError("Invalid attachment base64");
  const mediaType=match[1]!, kind=mediaType.startsWith("image/") ? "image" : "file";
  const ref: Obj={attachmentId:`sha256:${sha(data)}`,bytes:data.length,...(kind==="image"?{mediaType,...imageDimensions(data,mediaType),...(typeof a.name==="string"?{name:safeName(a.name)}:{})}:{name:safeName(a.name)})};
  const key=`${kind}:${ref.attachmentId}:${kind==="file"?ref.name:""}`;
  attachments.set(key,{ref,kind,base64:data.toString("base64")});
  blocks.push({type:kind,attachment:ref});
 }
 return blocks;
}
