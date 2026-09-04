import { defineDshSessionAdapter } from "@linmu/dsh-session-adapter-sdk";

import { inspectRc2, verifyRc2 } from "./inspect.js";
import { manifest } from "./manifest.js";
import { materializeRc2 } from "./materialize.js";
import { normalizeRc2Append } from "./normalize-append.js";
import { probeRc2 } from "./probe.js";
import { resolveRc2Reference } from "./references.js";

export { manifest } from "./manifest.js";
export { probeRc2 } from "./probe.js";
export { materializeRc2, materializeRc2Event, rc2NativeSessionId } from "./materialize.js";
export { normalizeRc2Append } from "./normalize-append.js";
export { inspectRc2, verifyRc2 } from "./inspect.js";
export { resolveRc2Reference } from "./references.js";
export * from "./runtime-bridge.js";

export const adapter = defineDshSessionAdapter({
  manifest,
  probe: async (environment) => probeRc2(environment),
  materialize: materializeRc2,
  normalizeAppend: async (operation) => normalizeRc2Append(operation),
  inspect: inspectRc2,
  verify: async (expected, actual) => verifyRc2(expected, actual),
  resolveReference: async (reference, run) => resolveRc2Reference(reference, run),
});
