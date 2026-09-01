import type {
  AdapterId,
  CanonicalEventV1,
  CanonicalSessionRecord,
  LogicalSessionId,
  LogicalWorkspaceId,
  NativeSessionId,
  OperationId,
  WorkspaceMembership,
} from "@linmu/dsh-session-contracts";

import { buildCanonicalVersion } from "./codex-observation.js";
import type {
  CanonicalEngineReceipt,
  CanonicalSessionEngine,
  CanonicalSessionEngineStore,
} from "./engine.js";

export interface DshNativeImportInput {
  readonly operationId: OperationId;
  readonly logicalSessionId: LogicalSessionId;
  readonly nativeSessionId: NativeSessionId;
  readonly title: string;
  readonly tags: readonly string[];
  readonly archivedAt: string | null;
  readonly workspaceId: LogicalWorkspaceId | null;
  readonly events: readonly CanonicalEventV1[];
  readonly importedAt: string;
}

export interface DshNativeImportCapability {
  readonly adapterId: AdapterId;
  readonly dshVersion: string;
  readonly status: "compatible" | "incompatible";
  readonly issues: readonly string[];
  /** Native cwd may identify a project, but cannot replace canonical workspace membership. */
  readonly workspaceMembershipAuthority: "maintenance" | "native-cwd";
}

export interface DshNativeImportSnapshot extends Omit<DshNativeImportInput, "operationId" | "importedAt"> {}

/** Version-aware source port. Concrete Alpha2 readers remain inside adapters. */
export interface DshNativeImportSource {
  probe(): Promise<DshNativeImportCapability>;
  read(nativeSessionId: NativeSessionId): Promise<DshNativeImportSnapshot>;
}

export class DshNativeImportService {
  readonly engine: Pick<CanonicalSessionEngine, "importDshNative">;
  readonly source: DshNativeImportSource;

  constructor(input: {
    readonly engine: Pick<CanonicalSessionEngine, "importDshNative">;
    readonly source: DshNativeImportSource;
  }) {
    this.engine = input.engine;
    this.source = input.source;
  }

  async import(input: {
    readonly operationId: OperationId;
    readonly nativeSessionId: NativeSessionId;
    readonly importedAt: string;
  }): Promise<CanonicalEngineReceipt> {
    const capability = await this.source.probe();
    if (capability.status !== "compatible") {
      throw new Error(`DSH native import adapter is incompatible with ${capability.dshVersion}: ${capability.issues.join("; ")}`);
    }
    if (capability.workspaceMembershipAuthority !== "maintenance") {
      throw new Error("DSH native import adapter must preserve Maintenance workspace membership independently of SessionHeader.cwd");
    }
    const snapshot = await this.source.read(input.nativeSessionId);
    if (snapshot.nativeSessionId !== input.nativeSessionId) {
      throw new TypeError("DSH native import source returned another native session");
    }
    return this.engine.importDshNative({
      ...snapshot,
      operationId: input.operationId,
      importedAt: input.importedAt,
    });
  }
}

function membership(input: DshNativeImportInput): WorkspaceMembership {
  return {
    schemaVersion: 1,
    logicalSessionId: input.logicalSessionId,
    workspaceId: input.workspaceId,
    displayOrder: 0,
    pinned: false,
    archived: input.archivedAt !== null,
    revision: 0,
  };
}

export async function importDshNative(
  store: CanonicalSessionEngineStore,
  input: DshNativeImportInput,
): Promise<CanonicalEngineReceipt> {
  const priorReceipt = await store.getOperationReceipt(input.operationId);
  if (priorReceipt !== undefined) return priorReceipt;

  const current = await store.getSession(input.logicalSessionId);
  if (current !== undefined && (
    current.session.authorityScope !== "maintenance"
    || current.session.originKind !== "maintenance-native"
  )) {
    throw new Error(`Native import cannot replace an existing non-native session: ${input.logicalSessionId}`);
  }
  if (current?.tombstone !== null && current?.tombstone.restoredAt === null) {
    throw new Error(`Native import cannot replace a tombstoned session: ${input.logicalSessionId}`);
  }

  const version = buildCanonicalVersion({
    logicalSessionId: input.logicalSessionId,
    parentVersionIds: [],
    events: input.events,
    workspaceId: input.workspaceId,
    title: input.title,
    tags: input.tags,
    archivedAt: input.archivedAt,
    createdAt: input.importedAt,
  });
  if (current?.headVersionId !== null && current !== undefined) {
    const head = await store.getVersion(current.headVersionId);
    if (head === undefined) throw new Error(`Canonical head version is missing: ${current.headVersionId}`);
    if (head.bodyDigest === version.bodyDigest && head.metadataDigest === version.metadataDigest) {
      return {
        outcome: "noop",
        operationId: input.operationId,
        logicalSessionId: input.logicalSessionId,
        versionId: head.id,
        tombstoneState: null,
        committedAt: input.importedAt,
      };
    }
    throw new Error(`Native import is initial-only and the session already has different content: ${input.logicalSessionId}`);
  }

  const session: CanonicalSessionRecord = {
    schemaVersion: 1,
    id: input.logicalSessionId,
    authorityScope: "maintenance",
    originKind: "maintenance-native",
    headVersionId: version.id,
    title: input.title,
    tags: [...input.tags],
    archivedAt: input.archivedAt,
    tombstonedAt: null,
    createdAt: input.importedAt,
    updatedAt: input.importedAt,
  };
  const receipt: CanonicalEngineReceipt = {
    outcome: "created",
    operationId: input.operationId,
    logicalSessionId: input.logicalSessionId,
    versionId: version.id,
    tombstoneState: null,
    committedAt: input.importedAt,
  };
  return store.commit({
    kind: "dsh-native-import",
    operationId: input.operationId,
    session,
    version,
    membership: membership(input),
    derivation: null,
    projectionReceipt: null,
    tombstone: null,
    observation: null,
    receipt,
  });
}
