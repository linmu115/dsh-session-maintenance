import { defineDshSessionAdapter } from "@linmu/dsh-session-adapter-sdk";

import { inspectRc1, verifyRc1 } from "./inspect.js";
import { manifest } from "./manifest.js";
import {
  rc1ProjectedNativeRevision,
  composeRc1ProjectionManifest,
  materializeRc1,
} from "./materialize.js";
import { normalizeRc1Append } from "./normalize-append.js";
import { probeRc1 } from "./probe.js";
import { resolveRc1Reference } from "./references.js";
import {
  recoverRc1ProjectionSession,
  recoverUnmappedRc1ProjectionSession,
} from "./recovery-session.js";
import { isRc1PreparationOnlyAppend } from "./runtime-tail-recovery.js";

export { manifest } from "./manifest.js";
export {
  rc1NativeSessionId,
  rc1ProjectedNativeRevision,
  composeRc1ProjectionManifest,
  materializeRc1,
} from "./materialize.js";
export { normalizeRc1Append, portableizeRc1CanonicalHistory } from "./normalize-append.js";
export { assertRc1SessionInvariants, inspectRc1, verifyRc1 } from "./inspect.js";
export { probeRc1 } from "./probe.js";
export { resolveRc1Reference } from "./references.js";
export * from "./runtime-bridge.js";
export * from "./recovery-session.js";
export * from "./runtime-tail-recovery.js";
export * from "./native-types.js";
export * from "./lineage.js";

export const adapter = defineDshSessionAdapter({
  manifest,
  probe: async (environment) => probeRc1(environment),
  materialize: materializeRc1,
  composeProjectionManifest: composeRc1ProjectionManifest,
  normalizeAppend: (operation, evidencePort) => normalizeRc1Append(operation, evidencePort),
  inspect: inspectRc1,
  verify: async (expected, actual) => verifyRc1(expected, actual),
  resolveReference: async (reference, run) => resolveRc1Reference(reference, run),
  projectedNativeRevision: (canonical, payload) => rc1ProjectedNativeRevision(canonical, payload),
  recoverProjectionSession: recoverRc1ProjectionSession,
  recoverUnmappedProjectionSession: recoverUnmappedRc1ProjectionSession,
  shouldSupersedeRecoveryAppend: isRc1PreparationOnlyAppend,
});
