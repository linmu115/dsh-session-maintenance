import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, link, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { JsonValue } from "@linmu/dsh-session-contracts";
import { record } from "./common.js";
import { imageDimensions, type PortableAttachment } from "./portable-content.js";

const hash=(data:Uint8Array)=>createHash("sha256").update(data).digest("hex");
export function validatePortableAttachments(value:JsonValue): readonly PortableAttachment[] {
 const payload=record(value),items=payload.portableAttachments??[];
 if(!Array.isArray(items))throw new TypeError("Invalid portable attachment inventory");
 return items.map(value=>{
  const item=record(value),ref=record(item.ref);
  if((item.kind!=="image"&&item.kind!=="file")||typeof item.base64!=="string")throw new TypeError("Invalid portable attachment item");
  const bytes=Buffer.from(item.base64,"base64");if(bytes.toString("base64")!==item.base64||ref.attachmentId!==`sha256:${hash(bytes)}`||ref.bytes!==bytes.length)throw new TypeError("Portable attachment digest or length differs");
  if(item.kind==="image") {const actual=imageDimensions(bytes,String(ref.mediaType));if(actual.width!==ref.width||actual.height!==ref.height)throw new TypeError("Portable image dimensions differ");}
  else if(typeof ref.name!=="string"||!ref.name.length||/[\\/\u0000-\u001f<>:"|?*]/.test(ref.name)||ref.name==="."||ref.name===".."||/[. ]$/.test(ref.name))throw new TypeError("Unsafe portable file name");
  return {ref,base64:item.base64,kind:item.kind};
 });
}
async function safePath(root:string,path:string):Promise<void>{
 const rel=relative(root,path);if(rel.startsWith("..")||isAbsolute(rel))throw new TypeError("Attachment path escapes owned space");
 for(let at=path;;at=dirname(at)){try{if((await lstat(at)).isSymbolicLink())throw new TypeError("Attachment resource contains a link");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}if(at===root)break;}
}
async function syncDirectory(path:string){if(process.platform==="win32")return;const handle=await open(path,"r");try{await handle.sync();}finally{await handle.close();}}
/** Additive immutable publication, never replacement. Every existing object is independently rehashed. */
async function publish(root:string,path:string,bytes:Buffer):Promise<void>{
 await safePath(root,path);await mkdir(dirname(path),{recursive:true,mode:0o700});await safePath(root,path);
 try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||hash(await readFile(path))!==hash(bytes))throw new TypeError("Existing attachment differs from canonical");return;}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
 const tmp=join(dirname(path),`.${randomUUID()}.pending`),file=await open(tmp,"wx",0o600);
 try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
 try{try{await link(tmp,path);}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}
  await safePath(root,path);if(hash(await readFile(path))!==hash(bytes))throw new TypeError("Published attachment failed verification");
  for(let at=dirname(path);;at=dirname(at)){await syncDirectory(at);if(at===root)break;}
 }finally{await unlink(tmp);}
}
/** RC2 attachment-local public contract: DSH_HOME/attachments/v1/{objects,file-objects,files}. */
export async function preparePortableResources(value:JsonValue,persistenceRoot:string):Promise<void>{
 const items=validatePortableAttachments(value);if(!items.length)return;
 const sessions=resolve(persistenceRoot),home=dirname(sessions);
 if(basename(sessions)!=="sessions"||!/^[a-f0-9]{64}$/.test(basename(home))||basename(dirname(home))!=="native-spaces")throw new TypeError("Attachments require a Broker-owned native space");
 await safePath(home,sessions);const root=join(home,"attachments","v1");
 for(const item of items){const digest=String(item.ref.attachmentId).slice(7),bytes=Buffer.from(item.base64,"base64");
  if(item.kind==="image")await publish(home,join(root,"objects",digest.slice(0,2),digest),bytes);
  else{await publish(home,join(root,"file-objects",digest.slice(0,2),digest),bytes);await publish(home,join(root,"files",digest.slice(0,2),digest,String(item.ref.name)),bytes);}
 }
}
