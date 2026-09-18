import {describe,it,expect} from "vitest";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {verifyDsh015RuntimeAttestation,DSH015_ATTESTATION_FILE} from "../src/integrations/runtime-attestation.js";
import {REQUIRED_CAPABILITIES} from "@linmu/dsh-session-adapter-0-1-5";
it("pins RC2 scope, closure, capabilities and exact artifact bytes before granting a binding",async()=>{
 const root=await mkdtemp(join(tmpdir(),"synthetic-runtime-attestation-"));try{
  const profileRoot=join(root,"profile"),homeRoot=join(root,"home");await mkdir(profileRoot);await mkdir(homeRoot);
  const files=[];for(const role of ["cli","node","session","sessionPersistence","formatCatalog","maintenancePlugin","engine","coreBindingReceipt"]){const path=join(root,role),content=`synthetic-${role}`;await writeFile(path,content);files.push({role,path,sha256:createHash("sha256").update(content).digest("hex")})}
  const receipt={schemaVersion:1,instanceId:"i",profileId:"web",homeRoot,adapterId:"dsh-0.1.5",formatId:"dsh-0.1.5-v3-jsonl-zstd-v1",runtimeVersion:"0.1.5-rc.2",engineVersion:"0.1.32-rc2.2",launcherCapabilityDigest:"a".repeat(64),runtimeCapabilities:[...REQUIRED_CAPABILITIES],files};
  const input={profileRoot,instanceId:"i",profileId:"web",homeRoot,cliPath:files[0]!.path,launcherDigest:receipt.launcherCapabilityDigest,resolvedManifests:[files[2]!.path]};
  const save=async(value:any)=>writeFile(join(profileRoot,DSH015_ATTESTATION_FILE),JSON.stringify(value));
  await save(receipt);expect((await verifyDsh015RuntimeAttestation(input)).coreBinding.path).toBe(files.at(-1)!.path);
  await save({...receipt,engineVersion:"0.1.33-rc2.1"});expect((await verifyDsh015RuntimeAttestation(input)).coreBinding.path).toBe(files.at(-1)!.path);
  await save({...receipt,engineVersion:"0.1.33-rc2.2"});expect((await verifyDsh015RuntimeAttestation(input)).coreBinding.path).toBe(files.at(-1)!.path);
  await save({...receipt,engineVersion:"0.1.33-rc2.3"});expect((await verifyDsh015RuntimeAttestation(input)).coreBinding.path).toBe(files.at(-1)!.path);
  await save({...receipt,engineVersion:"0.1.33-rc2.37"});expect((await verifyDsh015RuntimeAttestation(input)).coreBinding.path).toBe(files.at(-1)!.path);
  await save({...receipt,engineVersion:"0.1.33-rc2.38"});expect((await verifyDsh015RuntimeAttestation(input)).coreBinding.path).toBe(files.at(-1)!.path);
  const currentVersion=JSON.parse(await readFile(new URL("../package.json",import.meta.url),"utf8")).version;
  await save({...receipt,engineVersion:currentVersion});expect((await verifyDsh015RuntimeAttestation(input)).coreBinding.path).toBe(files.at(-1)!.path);
  for(const engineVersion of ["0.1.33-rc2.0","0.1.33-rc2.999",`${currentVersion}+unverified`]){await save({...receipt,engineVersion});await expect(verifyDsh015RuntimeAttestation(input)).rejects.toMatchObject({code:"V3_ATTESTATION_REQUIRED"});}
  const pluginPath=join(root,"gpt-plugin");await writeFile(pluginPath,"synthetic-gpt-plugin");
  const pluginPin={role:"sessionFormatPlugin",path:pluginPath,sha256:createHash("sha256").update("synthetic-gpt-plugin").digest("hex")};
  const gptReceipt={...receipt,engineVersion:currentVersion,adapterId:"dsh-0.1.5",formatId:"dsh-0.1.5-v3-jsonl-zstd-v1",runtimeCapabilities:[...REQUIRED_CAPABILITIES,"dsh-gpt-compat/session-v1"],files:[...files,pluginPin]};
  const gptInput={...input,expectedAdapterId:"dsh-0.1.5",resolvedManifests:[files[2]!.path,pluginPath]};
  await save(gptReceipt);await expect(verifyDsh015RuntimeAttestation(gptInput)).resolves.toHaveProperty("coreBinding");
  await save({...gptReceipt,adapterId:"dsh-gpt-compat",formatId:"dsh-gpt-compat-v1-jsonl-zstd"});await expect(verifyDsh015RuntimeAttestation(gptInput)).rejects.toMatchObject({code:"V3_ATTESTATION_REQUIRED"});
  await save({...gptReceipt,files});await expect(verifyDsh015RuntimeAttestation(gptInput)).rejects.toMatchObject({code:"GPT_FORMAT_ATTESTATION_REQUIRED"});
  await save(gptReceipt);await writeFile(pluginPath,"changed-plugin");await expect(verifyDsh015RuntimeAttestation(gptInput)).rejects.toMatchObject({code:"V3_ARTIFACT_CHANGED"});
  await save(receipt);
  await expect(verifyDsh015RuntimeAttestation({...input,instanceId:"other"})).rejects.toMatchObject({code:"V3_ATTESTATION_IDENTITY_MISMATCH"});
  const foreign=join(root,"foreign-manifest");await writeFile(foreign,"{}");await expect(verifyDsh015RuntimeAttestation({...input,resolvedManifests:[foreign]})).rejects.toMatchObject({code:"V3_PACKAGE_CLOSURE_MISMATCH"});
  await save({...receipt,runtimeCapabilities:[]});await expect(verifyDsh015RuntimeAttestation(input)).rejects.toMatchObject({code:"V3_CAPABILITY_MISSING"});
  await save({...receipt,files:files.slice(0,-1)});await expect(verifyDsh015RuntimeAttestation(input)).rejects.toMatchObject({code:"V3_ATTESTATION_INCOMPLETE"});
  await save({...receipt,engineVersion:currentVersion});await writeFile(files[2]!.path,"changed");await expect(verifyDsh015RuntimeAttestation(input)).rejects.toMatchObject({code:"V3_ARTIFACT_CHANGED"});
 }finally{await rm(root,{recursive:true,force:true})}
});
