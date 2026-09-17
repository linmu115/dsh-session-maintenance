import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec } from "@deepseek-ai/dsh-session-format-v0-to-v1";
import { releasedV2SessionFormatCodec } from "@deepseek-ai/dsh-session-format-v1-to-v2";
import type { SessionFormatEvent } from "@deepseek-ai/dsh-session-format";
import { migrateLegacy } from "./legacy-import.js";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, dirname } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { NativeSessionArtifact, NativeSessionId } from "@linmu/dsh-session-adapter-sdk";
import { currentCatalog } from "./official.js";
import { count, record } from "./common.js";
import { scanZstdFrames } from "./zstd-frames.js";
import { expectedV3ArtifactPath } from "./layout.js";
export function generationName(name:string): {version:number;compression:"none"|"zstd"}|undefined {
 const m=/^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/u.exec(name);if(!m)return undefined;
 return {version:count(Number(m[1]??0),"generation"),compression:m[2]?"zstd":"none"};
}
export function decodeGeneration(bytes:Buffer, compression:"none"|"zstd", version:number) {
 if(bytes.length>64*1024*1024)throw new TypeError("Native artifact exceeds read bound");
 let text:Buffer, complete:boolean;
 if(compression==="zstd") {const frames=scanZstdFrames(bytes);if(!frames.length)throw new TypeError("Missing complete header frame");let total=0;const chunks=frames.map(f=>{const value=zstdDecompressSync(bytes.subarray(f.start,f.end),{maxOutputLength:256*1024*1024-total});total+=value.length;return value;});text=Buffer.concat(chunks);complete=frames.at(-1)!.end===bytes.length;}
 else {const end=bytes.lastIndexOf(10);if(end<0)throw new TypeError("Missing complete header line");text=bytes.subarray(0,end+1);complete=end===bytes.length-1;}
 if(text.length>256*1024*1024)throw new TypeError("Decoded artifact exceeds bound");
 if(text.at(-1)!==10)throw new TypeError("Complete compressed frame has unterminated logical row");
 const lines=new TextDecoder("utf-8",{fatal:true}).decode(text).split("\n");lines.pop();if(lines.length>1_000_001)throw new TypeError("Too many native rows");
 const rows=lines.map(line=>{if(Buffer.byteLength(line)>8*1024*1024)throw new TypeError("Native row exceeds bound");return JSON.parse(line) as unknown;});
 const physical=record(rows.shift());if(physical.version!==version)throw new TypeError("Generation filename/header mismatch");
 // Strict logical admission: only torn physical tails can be ignored. A malformed complete row is never dropped.
 if(version<3){const codec=[releasedV0SessionFormatCodec,releasedV1SessionFormatCodec,releasedV2SessionFormatCodec][version];if(!codec)throw new TypeError("Unknown generation");const decoder=codec.createDecoder(physical,"strict"),events:SessionFormatEvent[]=[];const sink={emitEvent:(e:SessionFormatEvent)=>{events.push(e);},emitRun:(r:{expand():Iterable<SessionFormatEvent>})=>{events.push(...r.expand());}};for(const row of rows)decoder.decodeRow(row,sink);const inheritedEventCount=decoder.finish(sink);return {artifact:migrateLegacy({header:decoder.header,events,inheritedEventCount}).artifact,complete};}
 const restore=currentCatalog().createRestore(physical,{recovery:"strict",validation:"current"});for(const row of rows)restore.decodeRow(row);
 return {artifact:restore.finish(),complete};
}
export async function inspectV3NativeSpace(root:string):Promise<readonly NativeSessionArtifact[]> {
 const rootInfo=await lstat(root);if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())throw new TypeError("Invalid native root");const rootReal=await realpath(root), result:NativeSessionArtifact[]=[], ids=new Set<string>();
 async function walk(dir:string,depth:number):Promise<void>{if(depth>3)throw new TypeError("Unexpected native directory depth");const entries=await readdir(dir,{withFileTypes:true}), generations=entries.flatMap(e=>{const g=generationName(e.name);return g?[{...g,path:join(dir,e.name)}]:[];});
 for(const e of entries){if(e.isSymbolicLink())throw new TypeError("Native symlink refused");if(e.isDirectory())await walk(join(dir,e.name),depth+1);}
 if(!generations.length)return;
 if(new Set(generations.map(g=>g.version)).size!==generations.length)throw new TypeError("Conflicting native encodings");
 const version=Math.max(...generations.map(g=>g.version));if(version>3)throw new TypeError("Future Session generation refused");
 const selected=generations.filter(g=>g.version===version);if(selected.length!==1)throw new TypeError("Conflicting native encodings");const file=selected[0]!;const actual=await realpath(file.path);if(relative(rootReal,actual).startsWith(".."))throw new TypeError("Native path escaped root");
 if((await lstat(actual)).size>64*1024*1024)throw new TypeError("Native artifact exceeds read bound");
 const {artifact,complete}=decodeGeneration(await readFile(actual),file.compression,file.version);const id=artifact.header.id;
 if(ids.has(id))throw new TypeError("Duplicate native session identity");
 // Directory identity is invariant across format generations.
 const expected=dirname(expectedV3ArtifactPath(root,artifact.header,file.compression));if(resolve(dir).toLowerCase()!==resolve(expected).toLowerCase())throw new TypeError("Misplaced native artifact");
 ids.add(id);result.push({nativeSessionId:id as NativeSessionId,relativePath:relative(root,file.path),header:artifact.header,events:artifact.events,inheritedEventCount:artifact.inheritedEventCount,complete});}
 await walk(root,0);return result;
}
