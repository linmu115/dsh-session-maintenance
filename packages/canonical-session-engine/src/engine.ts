import type {
  AdapterContractRef,
  CanonicalEventV1,
  CanonicalSessionRecord,
  JsonValue,
  LogicalSessionId,
  LogicalWorkspaceId,
  OperationId,
  PlatformSessionKey,
  ProjectionOperationReceipt,
  SessionDerivation,
  SessionTombstone,
  SessionVersionId,
  StateFingerprint,
  WorkspaceMembership,
} from "@linmu/dsh-session-contracts";

import {
  observeCodex,
  retitleCodexMirror,
  type CodexMirrorRetitleInput,
  type CodexObservationInput,
} from "./codex-observation.js";
import { appendDsh, type DshAppendInput } from "./dsh-append.js";
import { importDshNative, type DshNativeImportInput } from "./dsh-native-import.js";
import {
  restoreSession,
  tombstoneSession,
  type RestoreSessionInput,
  type TombstoneSessionInput,
} from "./tombstone.js";

export interface CanonicalVersionRecord {
  readonly id: SessionVersionId;
  readonly logicalSessionId: LogicalSessionId;
  readonly parentVersionIds: readonly SessionVersionId[];
  readonly events: readonly CanonicalEventV1[];
  readonly workspaceId: LogicalWorkspaceId | null;
  readonly body: JsonValue;
  readonly metadata: JsonValue;
  readonly bodyDigest: string;
  readonly metadataDigest: string;
  readonly contentDigest: string;
  readonly createdAt: string;
}

export interface CanonicalSessionSnapshot {
  readonly session: CanonicalSessionRecord;
  readonly headVersionId: SessionVersionId | null;
  readonly workspaceId: LogicalWorkspaceId | null;
  readonly membershipRevision: number;
  readonly tombstone: SessionTombstone | null;
}

export interface CodexObservationRecord {
  readonly logicalSessionId: LogicalSessionId;
  readonly versionId: SessionVersionId;
  readonly sourceCursor: string | null;
  readonly observedAt: string;
  readonly bodyDigest: string;
  readonly metadataDigest: string;
  readonly authorityBinding: {
    readonly bindingId: string;
    readonly key: PlatformSessionKey;
    readonly adapterContract: AdapterContractRef;
    readonly fingerprint: StateFingerprint;
  } | null;
}

export type CanonicalEngineOutcome =
  | "created"
  | "advanced"
  | "noop"
  | "derived"
  | "tombstoned";

export interface CanonicalEngineReceipt {
  readonly outcome: CanonicalEngineOutcome;
  readonly operationId: OperationId | null;
  readonly logicalSessionId: LogicalSessionId;
  readonly versionId: SessionVersionId | null;
  readonly tombstoneState: "deleted" | "restored" | null;
  readonly committedAt: string;
}

export interface CanonicalEngineMutation {
  readonly kind: "codex-observation" | "dsh-native-import" | "dsh-append" | "dsh-derivation" | "tombstone" | "restore";
  readonly operationId: OperationId | null;
  readonly session: CanonicalSessionRecord;
  readonly version: CanonicalVersionRecord | null;
  readonly membership: WorkspaceMembership | null;
  readonly derivation: SessionDerivation | null;
  readonly projectionReceipt: ProjectionOperationReceipt | null;
  readonly tombstone: SessionTombstone | null;
  readonly observation: CodexObservationRecord | null;
  readonly receipt: CanonicalEngineReceipt;
}

export interface CanonicalSessionEngineStore {
  getSession(id: LogicalSessionId): Promise<CanonicalSessionSnapshot | undefined>;
  getVersion(id: SessionVersionId): Promise<CanonicalVersionRecord | undefined>;
  getOperationReceipt(operationId: OperationId): Promise<CanonicalEngineReceipt | undefined>;
  recordCodexObservation(input: CodexObservationRecord): Promise<void>;
  /** Optional storage-native metadata-only advance that reuses the current body object. */
  retitleCodexMirrorMetadata?(input: {
    readonly logicalSessionId: LogicalSessionId;
    readonly title: string;
    readonly appliedAt: string;
  }): Promise<CanonicalEngineReceipt | undefined>;
  /** Commits the content object, version head, membership, lineage and receipt atomically. */
  commit(input: CanonicalEngineMutation): Promise<CanonicalEngineReceipt>;
}

export class CanonicalSessionEngine {
  readonly store: CanonicalSessionEngineStore;

  constructor(store: CanonicalSessionEngineStore) {
    this.store = store;
  }

  async observeCodex(input: CodexObservationInput): Promise<CanonicalEngineReceipt> {
    return observeCodex(this.store, input);
  }

  retitleCodexMirror(input: CodexMirrorRetitleInput): Promise<CanonicalEngineReceipt | undefined> {
    return retitleCodexMirror(this.store, input);
  }

  async appendDsh(input: DshAppendInput): Promise<CanonicalEngineReceipt> {
    return appendDsh(this.store, input);
  }

  async importDshNative(input: DshNativeImportInput): Promise<CanonicalEngineReceipt> {
    return importDshNative(this.store, input);
  }

  async tombstone(input: TombstoneSessionInput): Promise<CanonicalEngineReceipt> {
    return tombstoneSession(this.store, input);
  }

  async restore(input: RestoreSessionInput): Promise<CanonicalEngineReceipt> {
    return restoreSession(this.store, input);
  }
}
