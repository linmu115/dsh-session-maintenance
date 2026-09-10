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
  describe(metadata: JsonValue, persistenceRoot: string): Promise<NativeSessionFileDescription>;
  encode(payload: JsonValue, description: NativeSessionFileDescription): Uint8Array;
  /** Strictly validates native layout and decodes all records, including complete zstd frames. */
  inspect(persistenceRoot: string): Promise<readonly NativeSessionArtifact[]>;
  isPreparationOnly(events: readonly JsonValue[]): boolean;
}
