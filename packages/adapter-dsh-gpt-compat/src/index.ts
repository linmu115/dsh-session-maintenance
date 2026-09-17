import { createV3DialectAdapter, REQUIRED_CAPABILITIES } from "@linmu/dsh-session-adapter-0-1-5";
import type { DshEnvironmentDescriptor, DshSessionAdapterV1 } from "@linmu/dsh-session-adapter-sdk";
import { catalog, knownEventTypes } from "./codec.js";
import { CAPABILITY, FORMAT_ID, manifest, supportsPluginVersion } from "./manifest.js";
export { CAPABILITY, FORMAT_ID, manifest, supportsPluginVersion } from "./manifest.js";
export { catalog, PLUGIN_EVENTS, validatePluginEvent } from "./codec.js";
export function probe(environment: DshEnvironmentDescriptor) {
  const issues = [];
  if (environment.dshVersion !== "0.1.5-rc.2" || ["@deepseek-ai/dsh-session", "@deepseek-ai/dsh-session-persistence", "@deepseek-ai/dsh-session-format-catalog"].some(p=>environment.packageVersions[p] !== "0.1.5-rc.2")) issues.push({code:"GPT_HOST_REQUIRED",message:"Requires exact RC2 host packages"});
  if (!supportsPluginVersion(environment.packageVersions["dsh-gpt-compat"]) || !environment.runtimeCapabilities.includes(CAPABILITY)) issues.push({code:"GPT_FORMAT_REQUIRED",message:"Requires attested GPT compatibility session-v1 plugin"});
  for (const capability of REQUIRED_CAPABILITIES) if (!environment.runtimeCapabilities.includes(capability)) issues.push({code:"GPT_CAPABILITY_MISSING",message:`Missing ${capability}`});
  return {status: issues.length ? "failed" as const : "verified" as const, manifest, detectedDshVersion:environment.dshVersion, capabilities:issues.length?[]:manifest.capabilities, issues};
}
const dialect = createV3DialectAdapter({ manifest, formatId: FORMAT_ID, catalog, knownEventTypes, probe });
export const adapter: DshSessionAdapterV1 = dialect.adapter;
export const createRuntimeBridge = dialect.createRuntimeBridge;
export const bindNativeAppend = dialect.bindNativeAppend;
export const recoverRuntimeTail = dialect.recoverRuntimeTail;
export const validateArtifact = dialect.validateArtifact;
export const verifyNativeContextMaterials = dialect.verifyNativeContextMaterials;
export const verifyNativeContextRelease = dialect.verifyNativeContextRelease;
