import type {
  AdapterEvidenceInputV1,
  AdapterEvidencePort,
  AdapterEvidenceRecordV1,
  CanonicalAppendOperation,
  CanonicalProjectionInput,
  CanonicalProjectionSessionInput,
  DshEnvironmentDescriptor,
  DshSessionAdapterV1,
  NativeAppendOperation,
  NativeSessionRegistration,
  NativeRecoverySession,
  UnmappedNativeRecoverySession,
  NativeReferenceResolution,
  ProjectionInspection,
  ProjectionManifest,
  ProjectionManifestCompositionInput,
  ProjectionReader,
  ProjectionSession,
  ProjectionWriter,
  StableSessionReference,
  AdapterProbeResult,
  AdapterVerificationResult,
} from "@linmu/dsh-session-contracts";

import { defineAdapterManifest } from "./manifest.js";

export function defineDshSessionAdapter<T extends DshSessionAdapterV1>(adapter: T): T {
  defineAdapterManifest(adapter.manifest);
  return adapter;
}

export type {
  AdapterEvidenceInputV1,
  AdapterEvidencePort,
  AdapterEvidenceRecordV1,
  AdapterProbeResult,
  AdapterVerificationResult,
  CanonicalAppendOperation,
  CanonicalProjectionInput,
  CanonicalProjectionSessionInput,
  DshEnvironmentDescriptor,
  DshSessionAdapterV1,
  NativeAppendOperation,
  NativeSessionRegistration,
  NativeRecoverySession,
  UnmappedNativeRecoverySession,
  NativeReferenceResolution,
  ProjectionInspection,
  ProjectionManifest,
  ProjectionManifestCompositionInput,
  ProjectionReader,
  ProjectionSession,
  ProjectionWriter,
  StableSessionReference,
};
