import type { NativeContextMaterialInput } from "./native-context.js";

export interface NativeContextMaterialsEvidenceInput {
  nativeSessionId: string;
  materials: readonly NativeContextMaterialInput[];
}
export interface NativeContextReleaseEvidenceInput extends NativeContextMaterialsEvidenceInput {
  operationId: string;
  surfaceEventSeqs?: readonly number[];
  sourceEventSeqs?: readonly number[];
}
export interface NativeContextReleaseEvidence {
  schemaVersion: 1;
  sourceEventSeqs: number[];
  surfaceEventSeqs: number[];
  materialIds: string[];
  /** Measured from persisted native replacements, not a host-supplied claim. */
  releasedBytes: number;
  proofDigest: string;
}
