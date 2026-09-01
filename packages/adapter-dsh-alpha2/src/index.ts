import { defineDshSessionAdapter } from "@linmu/dsh-session-adapter-sdk";

import { inspectAlpha2, verifyAlpha2 } from "./inspect.js";
import { manifest } from "./manifest.js";
import { materializeAlpha2 } from "./materialize.js";
import { normalizeAlpha2Append } from "./normalize-append.js";
import { probeAlpha2 } from "./probe.js";
import { resolveAlpha2Reference } from "./references.js";
import { recoverAlpha2ProjectionSession } from "./recovery-session.js";

export { manifest } from "./manifest.js";
export { alpha2NativeSessionId, materializeAlpha2, materializeEvent } from "./materialize.js";
export { normalizeAlpha2Append } from "./normalize-append.js";
export { inspectAlpha2, verifyAlpha2 } from "./inspect.js";
export { probeAlpha2 } from "./probe.js";
export { resolveAlpha2Reference } from "./references.js";
export * from "./runtime-bridge.js";
export * from "./recovery-session.js";
export * from "./runtime-tail-recovery.js";

export const adapter = defineDshSessionAdapter({
  manifest,
  probe: async (environment) => probeAlpha2(environment),
  materialize: materializeAlpha2,
  normalizeAppend: async (operation) => normalizeAlpha2Append(operation),
  inspect: inspectAlpha2,
  verify: async (expected, actual) => verifyAlpha2(expected, actual),
  resolveReference: async (reference, run) => resolveAlpha2Reference(reference, run),
  recoverProjectionSession: recoverAlpha2ProjectionSession,
});
