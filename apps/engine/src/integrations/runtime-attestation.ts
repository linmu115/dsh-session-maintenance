import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath,stat } from "node:fs/promises";
import { join,isAbsolute } from "node:path";
import { z } from "zod";
import { REQUIRED_CAPABILITIES } from "@linmu/dsh-session-adapter-0-1-5";
import { IntegrationError,readJsonIfPresent } from "./bindings.js";
const fileSchema=z.strictObject({role:z.string(),path:z.string().refine(isAbsolute),sha256:z.string().regex(/^[a-f0-9]{64}$/u)});
const schema=z.strictObject({schemaVersion:z.literal(1),instanceId:z.string(),profileId:z.string(),homeRoot:z.string(),adapterId:z.literal("dsh-0.1.5"),formatId:z.literal("dsh-0.1.5-v3-jsonl-zstd-v1"),runtimeVersion:z.literal("0.1.5-rc.2"),engineVersion:z.enum(["0.1.32-rc2.2","0.1.33-rc2.1","0.1.33-rc2.2","0.1.33-rc2.3","0.1.33-rc2.4","0.1.33-rc2.5","0.1.33-rc2.6","0.1.33-rc2.7","0.1.33-rc2.8","0.1.33-rc2.9","0.1.33-rc2.10","0.1.33-rc2.11","0.1.33-rc2.12","0.1.33-rc2.13","0.1.33-rc2.14","0.1.33-rc2.15","0.1.33-rc2.16","0.1.33-rc2.17","0.1.33-rc2.18","0.1.33-rc2.19","0.1.33-rc2.20","0.1.33-rc2.21","0.1.33-rc2.22","0.1.33-rc2.23","0.1.33-rc2.24"]),launcherCapabilityDigest:z.string().regex(/^[a-f0-9]{64}$/u),runtimeCapabilities:z.array(z.string()),files:z.array(fileSchema)});
export type Dsh015RuntimeAttestation=z.infer<typeof schema>;
export const DSH015_ATTESTATION_FILE="maintenance-runtime-attestation.json";
async function hashFile(path:string):Promise<string>{const before=await stat(path,{bigint:true}),hash=createHash("sha256");for await(const bytes of createReadStream(path))hash.update(bytes);const after=await stat(path,{bigint:true});if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ino!==after.ino)throw new TypeError("Attested artifact changed while reading");return hash.digest("hex");}
/** Read-only attestation check. Receipt producer must run the bounded host/handle capability probes against these exact files. */
export async function verifyDsh015RuntimeAttestation(input:{profileRoot:string;instanceId:string;profileId:string;homeRoot:string;cliPath:string;launcherDigest:string|null;resolvedManifests:readonly string[]}):Promise<{runtimeCapabilities:readonly string[];digest:string;coreBinding:{path:string;sha256:string}}> {
 const parsed=schema.safeParse(await readJsonIfPresent(join(input.profileRoot,DSH015_ATTESTATION_FILE)));if(!parsed.success)throw new IntegrationError("V3_ATTESTATION_REQUIRED","RC2 缺少实际宿主构件与 handle 能力验证回执。");const receipt=parsed.data;
 if(receipt.instanceId!==input.instanceId||receipt.profileId!==input.profileId||await realpath(receipt.homeRoot)!==await realpath(input.homeRoot)||receipt.launcherCapabilityDigest!==input.launcherDigest)throw new IntegrationError("V3_ATTESTATION_IDENTITY_MISMATCH","RC2 能力回执与实例、home 或 Launcher 不一致。");
 if(REQUIRED_CAPABILITIES.some(c=>!receipt.runtimeCapabilities.includes(c)))throw new IntegrationError("V3_CAPABILITY_MISSING","RC2 缺少经过验证的持久化能力。");
 const roles=new Map(receipt.files.map(f=>[f.role,f]));if(roles.size!==receipt.files.length||["cli","node","session","sessionPersistence","formatCatalog","maintenancePlugin","engine","coreBindingReceipt"].some(role=>!roles.has(role)))throw new IntegrationError("V3_ATTESTATION_INCOMPLETE","RC2 构件回执不完整。");
 if(await realpath(roles.get("cli")!.path)!==await realpath(input.cliPath))throw new IntegrationError("V3_CLI_MISMATCH","RC2 回执未绑定实际 CLI。");
 for(const manifest of input.resolvedManifests){const path=await realpath(manifest);if(!(await Promise.all(receipt.files.map(f=>realpath(f.path)))).includes(path))throw new IntegrationError("V3_PACKAGE_CLOSURE_MISMATCH","RC2 实际解析包未纳入构件回执。");}
 for(const file of receipt.files)if(await hashFile(file.path)!==file.sha256)throw new IntegrationError("V3_ARTIFACT_CHANGED",`RC2 构件 ${file.role} 已改变，请重新验收。`);
 return {runtimeCapabilities:receipt.runtimeCapabilities,coreBinding:roles.get("coreBindingReceipt")!,digest:createHash("sha256").update(JSON.stringify(receipt)).digest("hex")};
}
