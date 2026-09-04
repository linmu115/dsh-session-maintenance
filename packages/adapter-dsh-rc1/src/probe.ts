import type { AdapterProbeResult, DshEnvironmentDescriptor } from "@linmu/dsh-session-adapter-sdk";

import { manifest } from "./manifest.js";

const REQUIRED_RUNTIME_CAPABILITY = "sessionPersistence";
const RC1 = "0.1.2-rc.1";

export function probeRc1(environment: DshEnvironmentDescriptor): AdapterProbeResult {
  if (!environment.runtimeCapabilities.includes(REQUIRED_RUNTIME_CAPABILITY)) {
    return {
      status: "failed",
      manifest,
      detectedDshVersion: environment.dshVersion,
      capabilities: [],
      issues: [{
        code: "RC1_SESSION_PERSISTENCE_MISSING",
        message: "The DSH runtime did not expose sessionPersistence",
      }],
    };
  }
  const packageVersions = environment.packageVersions;
  const exactPackages = packageVersions["@deepseek-ai/dsh-session"] === RC1
    && packageVersions["@deepseek-ai/dsh-session-persistence"] === RC1;
  const exact = environment.dshVersion === RC1 && exactPackages;
  return {
    status: exact ? "verified" : "failed",
    manifest,
    detectedDshVersion: environment.dshVersion,
    capabilities: manifest.capabilities,
    issues: exact ? [] : [{
      code: "RC1_EXACT_PACKAGE_SET_REQUIRED",
      message: "This Adapter only accepts the exact DeepSeek Harness 0.1.2-rc.1 session package family",
    }],
  };
}
