import { currentDialect } from "./dialect.js";
import type { AdapterProbeResult, DshEnvironmentDescriptor } from "@linmu/dsh-session-adapter-sdk";
import { manifest } from "./manifest.js";
import { HOST_VERSION } from "./common.js";
export const REQUIRED_PACKAGES = ["@deepseek-ai/dsh-session", "@deepseek-ai/dsh-session-persistence", "@deepseek-ai/dsh-session-format-catalog"] as const;
export const REQUIRED_CAPABILITIES = ["sessionPersistence", "sessionPersistence.open", "sessionPersistence.stat", "sessionHandle", "session/event", "session/flush"] as const;
export function probeV3(environment: DshEnvironmentDescriptor): AdapterProbeResult {
 const custom = currentDialect();
 if (custom) return custom.probe(environment);
 const issues = [];
 if (environment.dshVersion !== HOST_VERSION || REQUIRED_PACKAGES.some(p => environment.packageVersions[p] !== HOST_VERSION)) issues.push({ code: "V3_EXACT_PACKAGE_SET_REQUIRED", message: `Requires actual resolved ${HOST_VERSION} session/persistence/catalog packages` });
 for (const capability of REQUIRED_CAPABILITIES) if (!environment.runtimeCapabilities.includes(capability)) issues.push({ code: "V3_CAPABILITY_MISSING", message: `Missing attested ${capability}` });
 return { status: issues.length ? "failed" : "verified", manifest, detectedDshVersion: environment.dshVersion, capabilities: issues.length ? [] : manifest.capabilities, issues };
}
