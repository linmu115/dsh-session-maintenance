import type { JsonValue } from "./model.js";
import type { NativeSessionId } from "./canonical.js";

/** Platform-owned physical layout and header; the orchestrator treats header as opaque. */
export interface NativeSessionFileDescription {
  readonly relativePath: string;
  readonly header: JsonValue;
}

export interface NativeSessionArtifact {
  readonly nativeSessionId: NativeSessionId;
  readonly relativePath: string;
  readonly header: JsonValue;
  readonly events: readonly JsonValue[];
  readonly inheritedEventCount: number;
  readonly complete: boolean;
}

export interface NativeSessionCodec {
  readonly formatId: string;
  /** Publish and verify immutable resources before the owning session can become ready. */
  prepareResources?(payload: JsonValue, persistenceRoot: string): Promise<void>;
  /** Metadata only; must never embed attachment bytes or session text. */
  resourceManifest?(payload: JsonValue): JsonValue;
  /** Verify retained immutable resources without reading the owning session body.
   * Return false only for missing resources which prepareResources can repair. */
  verifyResources?(manifest: JsonValue, persistenceRoot: string): Promise<boolean>;
  describe(metadata: JsonValue, persistenceRoot: string): Promise<NativeSessionFileDescription>;
  encode(payload: JsonValue, description: NativeSessionFileDescription): Uint8Array;
  /** Re-read staged bytes through the format decoder before atomic publication. */
  verifyEncoded?(bytes: Uint8Array, payload: JsonValue, description: NativeSessionFileDescription): void;
  /** Strictly validates native layout and decodes all records, including complete zstd frames. */
  inspect(persistenceRoot: string): Promise<readonly NativeSessionArtifact[]>;
  isPreparationOnly(events: readonly JsonValue[]): boolean;
  /** Admit an unregistered preparation artifact only against this run's registered
   * native parents. The codec verifies platform-specific inherited lineage. */
  isPreparationArtifact?(artifact: NativeSessionArtifact, registered: readonly NativeSessionArtifact[]): boolean;
}
