import type { AdapterProbeResult, DshEnvironmentDescriptor } from "@linmu/dsh-session-adapter-sdk";

import { manifest } from "./manifest.js";

const RC2 = "0.1.1-rc.2";
const HOOK = "legacySessionPersistence";

export function probeRc2(environment: DshEnvironmentDescriptor): AdapterProbeResult {
  if (!environment.runtimeCapabilities.includes(HOOK)) return {
    status: "failed", manifest, detectedDshVersion: environment.dshVersion, capabilities: [],
    issues: [{ code: "RC2_PERSISTENCE_HOOK_MISSING", message: "RC2 did not expose the isolated legacy session persistence hook" }],
  };
  const exact = environment.dshVersion === RC2 && environment.packageVersions["@deepseek-ai/dsh-session"] === RC2;
  const rcShape = environment.dshVersion.startsWith("0.1.1-rc.");
  return {
    status: exact ? "verified" : rcShape ? "compatible" : "experimental",
    manifest,
    detectedDshVersion: environment.dshVersion,
    capabilities: manifest.capabilities,
    issues: exact ? [] : [{
      code: rcShape ? "RC2_PACKAGE_SET_UNVERIFIED" : "RC2_EXPERIMENTAL_VERSION",
      message: rcShape ? "RC2 persistence shape matches but the exact package set is unverified" : "Legacy persistence hook is available outside the fixture-verified RC2 build",
    }],
  };
}
