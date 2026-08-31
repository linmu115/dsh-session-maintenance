import type { AdapterProbeResult, DshEnvironmentDescriptor } from "@linmu/dsh-session-adapter-sdk";

import { manifest } from "./manifest.js";

const REQUIRED_RUNTIME_CAPABILITY = "sessionPersistence";
const ALPHA2 = "0.1.2-alpha.2";

export function probeAlpha2(environment: DshEnvironmentDescriptor): AdapterProbeResult {
  if (!environment.runtimeCapabilities.includes(REQUIRED_RUNTIME_CAPABILITY)) {
    return {
      status: "failed",
      manifest,
      detectedDshVersion: environment.dshVersion,
      capabilities: [],
      issues: [{
        code: "ALPHA2_SESSION_PERSISTENCE_MISSING",
        message: "The DSH runtime did not expose sessionPersistence",
      }],
    };
  }
  const packageVersions = environment.packageVersions;
  const exactPackages = packageVersions["@deepseek-ai/dsh-session"] === ALPHA2
    && packageVersions["@deepseek-ai/dsh-session-persistence"] === ALPHA2;
  const exact = environment.dshVersion === ALPHA2 && exactPackages;
  const alpha2Shape = environment.dshVersion.startsWith("0.1.2-alpha.");
  return {
    status: exact ? "verified" : alpha2Shape ? "compatible" : "experimental",
    manifest,
    detectedDshVersion: environment.dshVersion,
    capabilities: manifest.capabilities,
    issues: exact ? [] : [{
      code: alpha2Shape ? "ALPHA2_PACKAGE_SET_UNVERIFIED" : "ALPHA2_EXPERIMENTAL_VERSION",
      message: alpha2Shape
        ? "Runtime capabilities match Alpha2, but the exact core package set was not observed"
        : "The runtime is outside the fixture-verified Alpha2 build; capability probing remains experimental",
    }],
  };
}
