import { createV3DialectAdapter, REQUIRED_CAPABILITIES, REQUIRED_PACKAGES, manifest } from "@linmu/dsh-session-adapter-0-1-5";
import type { DshEnvironmentDescriptor } from "@linmu/dsh-session-adapter-sdk";
import { catalog, knownEventTypes, PLUGIN_EVENTS } from "./codec.js";
import { CAPABILITY, FORMAT_ID, supportsPluginVersion } from "./manifest.js";
export * from "./manifest.js";
export { catalog, PLUGIN_EVENTS, validatePluginEvent } from "./codec.js";
export { gptCompatExtensionAdapter, summarizeSessionEvents } from "./extension.js";
/** Host probe remains DSH. A configured plugin additionally requires its own attestation. */
export function probe(environment: DshEnvironmentDescriptor) {
  const issues = [];
  if (environment.dshVersion !== "0.1.5-rc.2" || REQUIRED_PACKAGES.some(p => environment.packageVersions[p] !== "0.1.5-rc.2"))
    issues.push({code:"V3_EXACT_PACKAGE_SET_REQUIRED",message:"Requires exact RC2 host packages"});
  for (const capability of REQUIRED_CAPABILITIES) if (!environment.runtimeCapabilities.includes(capability))
    issues.push({code:"V3_CAPABILITY_MISSING",message:`Missing ${capability}`});
  const version = environment.packageVersions["dsh-gpt-compat"];
  if ((version !== undefined || environment.runtimeCapabilities.includes(CAPABILITY)) &&
      (!supportsPluginVersion(version) || !environment.runtimeCapabilities.includes(CAPABILITY)))
    issues.push({code:"GPT_EXTENSION_REQUIRED",message:"Configured GPT extension requires a supported version and attested native events"});
  return {status: issues.length ? "failed" as const : "verified" as const, manifest, detectedDshVersion:environment.dshVersion, capabilities:issues.length?[]:manifest.capabilities, issues};
}
/** Trusted extension codecs compose into the existing host; they never register a Harness. */
const host = createV3DialectAdapter({ manifest, formatId: FORMAT_ID, catalog, knownEventTypes, probe,
  eventOwners: new Map([...PLUGIN_EVENTS].map(type => [type, "gpt-compat"])),
  legacyOwners: [{adapterId:"dsh-gpt-compat", formatId:"dsh-gpt-compat-v1-jsonl-zstd"}],
});
export const adapter: typeof import("@linmu/dsh-session-adapter-0-1-5").adapter = host.adapter;
export const createRuntimeBridge = host.createRuntimeBridge;
export const bindNativeAppend = host.bindNativeAppend;
export const recoverRuntimeTail = host.recoverRuntimeTail;
export const validateArtifact = host.validateArtifact;
export const verifyNativeContextMaterials = host.verifyNativeContextMaterials;
export const verifyNativeContextRelease = host.verifyNativeContextRelease;
