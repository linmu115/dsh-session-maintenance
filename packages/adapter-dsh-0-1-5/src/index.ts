import { defineDshSessionAdapter } from "@linmu/dsh-session-adapter-sdk";
import { v3SessionContext } from "./session-context.js";
import { v3SessionGraph } from "./session-graph.js";

import { inspectV3, verifyV3 } from "./inspect.js";
import { manifest } from "./manifest.js";
import {
  v3ProjectedNativeRevision,
  composeV3ProjectionManifest,
  materializeV3,
} from "./materialize.js";
import { normalizeV3Append } from "./normalize-append.js";
import { restoreV3Metadata, ownsV3CanonicalEvent } from "./native-metadata.js";
import { probeV3 } from "./probe.js";
import { resolveV3Reference } from "./references.js";
import {
  recoverV3ProjectionSession,
  recoverUnmappedV3ProjectionSession,
} from "./recovery-session.js";
import { isV3PreparationOnlyAppend } from "./runtime-tail-recovery.js";
import { v3NativeSessionCodec } from "./native-session-codec.js";
export { v3NativeSessionCodec } from "./native-session-codec.js";

export { manifest } from "./manifest.js";
export {
  v3NativeSessionId,
  v3ProjectedNativeRevision,
  composeV3ProjectionManifest,
  materializeV3,
} from "./materialize.js";
export { normalizeV3Append } from "./normalize-append.js";
export { inspectV3, verifyV3 } from "./inspect.js";
export { probeV3 } from "./probe.js";
export { resolveV3Reference } from "./references.js";
export * from "./runtime-bridge.js";
export * from "./recovery-session.js";
export * from "./runtime-tail-recovery.js";
export * from "./native-types.js";
export * from "./lineage.js";
export { readDshReaderPresentation, type DshReaderPresentation } from "./reader-presentation.js";


export const adapter = defineDshSessionAdapter({
  sessionContext: v3SessionContext,
  sessionGraph: v3SessionGraph,
  manifest,
  acceptsSourceExports: true,
  ownsCanonicalEvent: ownsV3CanonicalEvent,
  nativeSessionCodec: v3NativeSessionCodec,
  restoreNativeEvents: restoreV3Metadata,
  probe: async (environment) => probeV3(environment),
  materialize: materializeV3,
  composeProjectionManifest: composeV3ProjectionManifest,
  normalizeAppend: (operation, evidencePort) => normalizeV3Append(operation, evidencePort),
  inspect: inspectV3,
  verify: async (expected, actual) => verifyV3(expected, actual),
  resolveReference: (reference, run, reader) => resolveV3Reference(reference, run, reader),
  projectedNativeRevision: (canonical, payload) => v3ProjectedNativeRevision(canonical, payload),
  recoverProjectionSession: recoverV3ProjectionSession,
  recoverUnmappedProjectionSession: recoverUnmappedV3ProjectionSession,
  shouldSupersedeRecoveryAppend: isV3PreparationOnlyAppend,
});

export { REQUIRED_CAPABILITIES, REQUIRED_PACKAGES } from "./probe.js";

export { expectedV3ArtifactPath as v3NativeArtifactPath } from "./layout.js";
export { validateV3 as validateV3Artifact } from "./official.js";
export * from "./reader-storage.js";
