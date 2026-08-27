import {
  CONTRACT_SCHEMA_VERSION,
  SessionMaintenanceError,
  syncPlanSchema,
  type AdapterContractRef,
  type BindingSnapshot,
  type JsonValue,
  type NormalizedEvent,
  type PlatformSessionKey,
  type PlannedOperation,
  type StateFingerprint,
  type SyncPlan,
} from "@linmu/dsh-session-contracts";

import { canonicalJson, sha256Canonical } from "./canonical-json.js";
import {
  classifyConversationDelta,
  classifyMetadataDelta,
  type SessionMetadata,
} from "./diff.js";

type JsonObject = { readonly [key: string]: JsonValue };

export interface PlanningHead {
  readonly snapshot: BindingSnapshot;
  readonly events: readonly NormalizedEvent[];
  readonly metadata: SessionMetadata;
}

export type PlanningTarget =
  | { readonly kind: "present"; readonly head: PlanningHead }
  | {
      readonly kind: "missing";
      readonly key: PlatformSessionKey;
      readonly targetInstanceId: string;
      readonly previouslyObserved: boolean;
    };

export interface CreateSyncPlanRequest {
  readonly createdAt: string;
  readonly logicalSessionId: string;
  readonly baseVersionId?: string;
  readonly base: {
    readonly events: readonly NormalizedEvent[];
    readonly metadata: SessionMetadata;
  };
  readonly source: PlanningHead;
  readonly target: PlanningTarget;
  readonly adapterContracts: readonly AdapterContractRef[];
  readonly identityConflict?: boolean;
}

export interface PlanRepository {
  savePlan(plan: SyncPlan): Promise<void>;
}

function fingerprintJson(fingerprint: StateFingerprint): JsonObject {
  return {
    platform: fingerprint.platform,
    instanceId: fingerprint.instanceId,
    sessionId: fingerprint.sessionId,
    kind: fingerprint.kind,
    value: fingerprint.value,
  };
}

function snapshotJson(snapshot: BindingSnapshot): JsonObject {
  return {
    bindingId: snapshot.bindingId,
    key: {
      platform: snapshot.key.platform,
      instanceId: snapshot.key.instanceId,
      sessionId: snapshot.key.sessionId,
    },
    versionId: snapshot.versionId,
    fingerprints: snapshot.fingerprints.map(fingerprintJson),
  };
}

function operationJson(operation: PlannedOperation): JsonObject {
  switch (operation.type) {
    case "create-target-session":
      return { type: operation.type, targetInstanceId: operation.targetInstanceId };
    case "append-events":
      return { type: operation.type, fromIndex: operation.fromIndex, eventIds: [...operation.eventIds] };
    case "update-title":
      return { type: operation.type, title: operation.title };
    case "update-archive":
      return { type: operation.type, archived: operation.archived };
    case "deletion-candidate":
      return {
        type: operation.type,
        missing: {
          platform: operation.missing.platform,
          instanceId: operation.missing.instanceId,
          sessionId: operation.missing.sessionId,
        },
      };
    case "require-review":
      return { type: operation.type, reason: operation.reason };
  }
}

function adapterContractJson(contract: AdapterContractRef): JsonObject {
  return {
    adapter: contract.adapter,
    platformVersion: contract.platformVersion,
    schemaFingerprint: contract.schemaFingerprint,
  };
}

export function syncPlanIdentityPayload(plan: Omit<SyncPlan, "id" | "hash">): JsonValue {
  return {
    schemaVersion: plan.schemaVersion,
    createdAt: plan.createdAt,
    logicalSessionId: plan.logicalSessionId,
    ...(plan.baseVersionId === undefined ? {} : { baseVersionId: plan.baseVersionId }),
    source: snapshotJson(plan.source),
    ...(plan.target === undefined ? {} : { target: snapshotJson(plan.target) }),
    adapterContracts: plan.adapterContracts.map(adapterContractJson),
    operations: plan.operations.map(operationJson),
    risk: plan.risk,
    confirmations: plan.confirmations.map((confirmation) => ({
      kind: confirmation.kind,
      code: confirmation.code,
      message: confirmation.message,
    })),
    preconditions: plan.preconditions.map(fingerprintJson),
  };
}

export function computeSyncPlanIdentity(
  plan: Omit<SyncPlan, "id" | "hash">,
): { readonly id: string; readonly hash: string } {
  const hex = sha256Canonical(syncPlanIdentityPayload(plan));
  return { id: `plan_${hex.slice(0, 24)}`, hash: `sha256:${hex}` };
}

export function verifySyncPlanIdentity(plan: SyncPlan): boolean {
  const { id: _id, hash: _hash, ...content } = plan;
  const expected = computeSyncPlanIdentity(content);
  return plan.id === expected.id && plan.hash === expected.hash;
}

function fingerprintKey(fingerprint: StateFingerprint): string {
  return canonicalJson(fingerprintJson(fingerprint));
}

function collectPreconditions(request: CreateSyncPlanRequest): readonly StateFingerprint[] {
  const all = [
    ...request.source.snapshot.fingerprints,
    ...(request.target.kind === "present" ? request.target.head.snapshot.fingerprints : []),
  ];
  const unique = new Map<string, StateFingerprint>();
  for (const fingerprint of all) {
    unique.set(fingerprintKey(fingerprint), { ...fingerprint });
  }
  return [...unique.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, fingerprint]) => fingerprint);
}

function reviewOperation(reason: Extract<PlannedOperation, { type: "require-review" }>["reason"]): {
  readonly operations: readonly PlannedOperation[];
  readonly risk: "review";
  readonly confirmations: SyncPlan["confirmations"];
} {
  return {
    operations: [{ type: "require-review", reason }],
    risk: "review",
    confirmations: [
      {
        kind: "review",
        code: reason,
        message: `Manual review is required: ${reason}`,
      },
    ],
  };
}

function planPresentTarget(request: CreateSyncPlanRequest & { readonly target: { readonly kind: "present"; readonly head: PlanningHead } }): {
  readonly operations: readonly PlannedOperation[];
  readonly risk: SyncPlan["risk"];
  readonly confirmations: SyncPlan["confirmations"];
} {
  if (request.identityConflict === true) {
    return reviewOperation("IDENTITY_CONFLICT");
  }

  const target = request.target.head;
  const sourceExtendsTarget = classifyConversationDelta(target.events, request.source.events);
  const targetExtendsSource = classifyConversationDelta(request.source.events, target.events);
  const operations: PlannedOperation[] = [];

  if (sourceExtendsTarget === "append-only") {
    operations.push({
      type: "append-events",
      fromIndex: target.events.length,
      eventIds: request.source.events.slice(target.events.length).map((event) => event.id),
    });
  } else if (targetExtendsSource !== "append-only" && sourceExtendsTarget !== "unchanged") {
    const sourceFromBase = classifyConversationDelta(request.base.events, request.source.events);
    const targetFromBase = classifyConversationDelta(request.base.events, target.events);
    if (sourceFromBase === "append-only" && targetFromBase === "append-only") {
      return reviewOperation("DIVERGED");
    }
    return reviewOperation("REWRITTEN");
  }

  const metadata = classifyMetadataDelta(
    request.base.metadata,
    request.source.metadata,
    target.metadata,
  );
  if (metadata === "metadata-conflict") {
    return reviewOperation("METADATA_CONFLICT");
  }
  if (metadata === "source-only") {
    if (request.source.metadata.title !== target.metadata.title) {
      operations.push({ type: "update-title", title: request.source.metadata.title });
    }
    if (request.source.metadata.archived !== target.metadata.archived) {
      operations.push({ type: "update-archive", archived: request.source.metadata.archived });
    }
  }

  return { operations, risk: "safe", confirmations: [] };
}

export function createSyncPlan(request: CreateSyncPlanRequest): SyncPlan {
  const decision =
    request.target.kind === "present"
      ? planPresentTarget(request as CreateSyncPlanRequest & {
          readonly target: { readonly kind: "present"; readonly head: PlanningHead };
        })
      : request.identityConflict === true
        ? reviewOperation("IDENTITY_CONFLICT")
        : request.target.previouslyObserved
          ? {
              operations: [{ type: "deletion-candidate", missing: request.target.key }] as const,
              risk: "destructive" as const,
              confirmations: [
                {
                  kind: "destructive" as const,
                  code: "DELETION_CANDIDATE",
                  message: "A previously observed platform session is missing",
                },
              ],
            }
          : {
              operations: [
                { type: "create-target-session", targetInstanceId: request.target.targetInstanceId },
              ] as const,
              risk: "safe" as const,
              confirmations: [],
            };

  const content: Omit<SyncPlan, "id" | "hash"> = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    createdAt: request.createdAt,
    logicalSessionId: request.logicalSessionId,
    ...(request.baseVersionId === undefined ? {} : { baseVersionId: request.baseVersionId }),
    source: {
      ...request.source.snapshot,
      key: { ...request.source.snapshot.key },
      fingerprints: request.source.snapshot.fingerprints.map((fingerprint) => ({ ...fingerprint })),
    },
    ...(request.target.kind === "present"
      ? {
          target: {
            ...request.target.head.snapshot,
            key: { ...request.target.head.snapshot.key },
            fingerprints: request.target.head.snapshot.fingerprints.map((fingerprint) => ({
              ...fingerprint,
            })),
          },
        }
      : {}),
    adapterContracts: request.adapterContracts.map((contract) => ({ ...contract })),
    operations: decision.operations,
    risk: decision.risk,
    confirmations: decision.confirmations,
    preconditions: collectPreconditions(request),
  };
  const identity = computeSyncPlanIdentity(content);
  const plan: SyncPlan = { ...content, ...identity };
  syncPlanSchema.parse(plan);
  return plan;
}

export function validatePlanPreconditions(
  plan: SyncPlan,
  fingerprints: readonly StateFingerprint[],
): void {
  const expected = plan.preconditions.map(fingerprintKey);
  const actual = fingerprints.map(fingerprintKey);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const equal =
    expectedSet.size === expected.length &&
    actualSet.size === actual.length &&
    expectedSet.size === actualSet.size &&
    [...expectedSet].every((item) => actualSet.has(item));
  if (!equal) {
    throw new SessionMaintenanceError(
      "PLAN_STALE",
      "PLAN_STALE: current platform fingerprints do not match the immutable plan",
    );
  }
}

export interface ExecutableDshPlanShape {
  readonly kind: "mutation" | "no-op";
  readonly targetInstanceId: string;
}

/**
 * The final fail-closed gate between planning and the recoverable DSH writer.
 * Planning may describe review/destructive outcomes, but this function admits
 * only the narrow Codex -> DSH shapes implemented by the locked rc.2 adapter.
 */
export function validateExecutableDshPlan(plan: SyncPlan): ExecutableDshPlanShape {
  const operationTypes = plan.operations.map((operation) => operation.type);
  const allowed = new Set(["create-target-session", "append-events", "update-title", "update-archive"]);
  const create = plan.operations.find((operation) => operation.type === "create-target-session");
  const append = plan.operations.find((operation) => operation.type === "append-events");
  const targetInstanceId = plan.target?.key.instanceId ??
    (create?.type === "create-target-session" ? create.targetInstanceId : undefined);
  const invalid =
    plan.risk !== "safe" ||
    plan.confirmations.length !== 0 ||
    plan.source.key.platform !== "codex" ||
    targetInstanceId === undefined ||
    operationTypes.some((type) => !allowed.has(type)) ||
    new Set(operationTypes).size !== operationTypes.length ||
    (plan.target === undefined) !== (create?.type === "create-target-session") ||
    (plan.target !== undefined && plan.target.key.platform !== "dsh") ||
    (append?.type === "append-events" &&
      (plan.target === undefined || append.fromIndex < 0 || append.eventIds.length === 0));
  if (invalid) {
    throw new SessionMaintenanceError(
      "WRITE_CAPABILITY_UNAVAILABLE",
      `Plan is not an executable Codex-to-DSH fast-forward: ${plan.id}`,
    );
  }
  return {
    kind: plan.operations.length === 0 ? "no-op" : "mutation",
    targetInstanceId,
  };
}

export class PlanningService {
  readonly repository: PlanRepository;

  constructor(repository: PlanRepository) {
    this.repository = repository;
  }

  async create(request: CreateSyncPlanRequest): Promise<SyncPlan> {
    const plan = createSyncPlan(request);
    await this.repository.savePlan(plan);
    return plan;
  }

  validate(plan: SyncPlan, fingerprints: readonly StateFingerprint[]): void {
    validatePlanPreconditions(plan, fingerprints);
  }
}
