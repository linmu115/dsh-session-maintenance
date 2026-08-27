import { resolve, join } from "node:path";

import type { DshCoreSnapshot, DshCoreState } from "@linmu/dsh-core-extension";
import type { DshHostGateway } from "@linmu/dsh-host-gateway";
import {
  SessionMaintenanceError,
  type BackupManifest,
  type JsonValue,
  type NormalizedSession,
  type PlatformWriteAdapter,
  type PreparedWrite,
  type PrepareWriteRequest,
  type RegisteredInstance,
  type RestoreReceipt,
  type StateFingerprint,
  type SyncPlan,
  type TransactionContext,
  type VerificationResult,
  type WriteProbe,
  type WriteReceipt,
} from "@linmu/dsh-session-contracts";
import { canonicalJson, sha256Canonical } from "@linmu/dsh-session-domain";
import { TransactionBackupStore } from "@linmu/dsh-session-transaction-engine";

import { dshWriteProbe } from "./contract.js";
import { prepareDshEvents, validateDshSourceEvents } from "./events.js";
import {
  PreparedDshWriteStore,
  type DshPreparedCaptured,
  type DshPreparedDescriptor,
} from "./prepared-store.js";

export interface DshWriteAdapterOptions {
  readonly stateRoot: string;
  readonly gateway: DshHostGateway;
  readonly loadSource: (plan: SyncPlan) => Promise<NormalizedSession>;
  readonly now?: () => Date;
}

function createSessionId(plan: SyncPlan): string {
  return `session_maintenance_${sha256Canonical({
    logicalSessionId: plan.logicalSessionId,
    planHash: plan.hash,
  }).slice(0, 24)}`;
}

function operation<T extends SyncPlan["operations"][number]["type"]>(
  plan: SyncPlan,
  type: T,
): Extract<SyncPlan["operations"][number], { readonly type: T }> | undefined {
  return plan.operations.find((item) => item.type === type) as
    | Extract<SyncPlan["operations"][number], { readonly type: T }>
    | undefined;
}

function assertSupportedPlan(plan: SyncPlan): void {
  const allowed = new Set(["create-target-session", "append-events", "update-title", "update-archive"]);
  if (
    plan.risk !== "safe" ||
    plan.operations.some((item) => !allowed.has(item.type)) ||
    new Set(plan.operations.map((item) => item.type)).size !== plan.operations.length
  ) {
    throw new SessionMaintenanceError(
      "WRITE_CAPABILITY_UNAVAILABLE",
      `Unsupported DSH write plan shape: ${plan.id}`,
    );
  }
}

function fingerprint(instanceId: string, sessionId: string, state: DshCoreState): StateFingerprint {
  return {
    platform: "dsh",
    instanceId,
    sessionId,
    kind: "content",
    value: state.digest,
  };
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function receiptDigest(receipt: WriteReceipt): string | undefined {
  const details = receipt.details;
  if (!isJsonObject(details)) return undefined;
  return typeof details.stateDigest === "string" ? details.stateDigest : undefined;
}

function snapshotFrom(bytes: Uint8Array): DshCoreSnapshot {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as DshCoreSnapshot;
  } catch (error) {
    throw new SessionMaintenanceError("BACKUP_CORRUPT", "DSH Core snapshot is not JSON", {
      cause: error,
    });
  }
}

export class DshWriteAdapter implements PlatformWriteAdapter {
  readonly platform = "dsh" as const;
  readonly stateRoot: string;
  readonly gateway: DshHostGateway;
  readonly loadSource: DshWriteAdapterOptions["loadSource"];
  readonly now: () => Date;
  readonly preparedStore: PreparedDshWriteStore;

  constructor(options: DshWriteAdapterOptions) {
    this.stateRoot = options.stateRoot;
    this.gateway = options.gateway;
    this.loadSource = options.loadSource;
    this.now = options.now ?? (() => new Date());
    this.preparedStore = new PreparedDshWriteStore(options.stateRoot);
  }

  async probeWrite(instance: RegisteredInstance): Promise<WriteProbe> {
    return dshWriteProbe(instance, await this.gateway.probeInstance(instance.id));
  }

  async prepare(request: PrepareWriteRequest): Promise<PreparedWrite> {
    assertSupportedPlan(request.plan);
    const source = await this.loadSource(request.plan);
    if (
      source.key.platform !== request.plan.source.key.platform ||
      source.key.instanceId !== request.plan.source.key.instanceId ||
      source.key.sessionId !== request.plan.source.key.sessionId
    ) {
      throw new SessionMaintenanceError("IDENTITY_CONFLICT", "Loaded source does not match DSH plan");
    }
    const create = operation(request.plan, "create-target-session") !== undefined;
    const append = operation(request.plan, "append-events");
    if (create && request.plan.target !== undefined) {
      throw new SessionMaintenanceError("IDENTITY_CONFLICT", "Create plan unexpectedly has a DSH target");
    }
    if (!create && request.plan.target?.key.platform !== "dsh") {
      throw new SessionMaintenanceError("IDENTITY_CONFLICT", "Append plan has no DSH target");
    }
    const sessionId = create ? createSessionId(request.plan) : request.plan.target!.key.sessionId;
    const sourceEvents = create
      ? source.events
      : append === undefined
        ? []
        : source.events.slice(append.fromIndex);
    if (
      append !== undefined &&
      canonicalJson(append.eventIds as unknown as JsonValue) !==
        canonicalJson(sourceEvents.map((event) => event.id) as unknown as JsonValue)
    ) {
      throw new SessionMaintenanceError("PLAN_STALE", "DSH append event identities drifted");
    }
    validateDshSourceEvents(sourceEvents);
    const titleOperation = operation(request.plan, "update-title");
    const archiveOperation = operation(request.plan, "update-archive");
    const intent = await this.preparedStore.writeIntent({
      schemaVersion: 1,
      phase: "intent",
      transactionId: request.transaction.id,
      planId: request.plan.id,
      planHash: request.plan.hash,
      instanceId: request.instance.id,
      sessionId,
      sourceVersionId: request.plan.source.versionId,
      sourceBodyHash: source.bodyHash,
      sourceEvents: sourceEvents.map((event) => ({ ...event })),
      create,
      ...(create || titleOperation !== undefined
        ? { title: titleOperation?.title ?? source.title }
        : {}),
      ...(create || archiveOperation !== undefined
        ? { archived: archiveOperation?.archived ?? source.archived }
        : {}),
    });
    return {
      id: `prepared-${request.transaction.id}`,
      planId: request.plan.id,
      planHash: request.plan.hash,
      platform: "dsh",
      instanceId: request.instance.id,
      rootIdentity: resolve(request.instance.root).toLocaleLowerCase("en-US"),
      targetKey: {
        platform: "dsh",
        instanceId: request.instance.id,
        sessionId,
      },
      expected: { fingerprints: [] },
      payload: { descriptorHash: intent.hash },
    };
  }

  async backup(prepared: PreparedWrite, transaction: TransactionContext): Promise<BackupManifest> {
    const intent = await this.preparedStore.read(transaction.id);
    this.assertScope(prepared, transaction, intent);
    if (intent.phase !== "intent") {
      throw new SessionMaintenanceError("BACKUP_CORRUPT", "DSH prepare phase already advanced");
    }
    const client = this.client(intent);
    const snapshot = await client.capture(intent.workspaceId);
    if (snapshot.session.exists === intent.create) {
      throw new SessionMaintenanceError(
        "PLAN_STALE",
        `DSH target existence changed before backup: ${intent.sessionId}`,
      );
    }
    const native = prepareDshEvents({
      planHash: intent.planHash,
      sessionId: intent.sessionId,
      createdAt: transaction.startedAt,
      create: intent.create,
      sourceEvents: intent.sourceEvents,
      ...(intent.title === undefined ? {} : { title: intent.title }),
      snapshot,
    });
    const store = this.backupStore(transaction.id);
    const snapshotEntry = await store.put(
      "dsh-core-snapshot",
      Buffer.from(canonicalJson(snapshot as unknown as JsonValue)),
      true,
    );
    const { hash: intentHash, ...intentPayload } = intent;
    void intentHash;
    await this.preparedStore.writeCaptured({
      ...intentPayload,
      phase: "captured",
      ...(native.header === undefined ? {} : { header: native.header }),
      events: native.events,
      snapshotHash: snapshot.hash,
      snapshotEntry,
    });
    return store.finalize(transaction.id, [snapshotEntry], this.now().toISOString());
  }

  async commit(prepared: PreparedWrite, transaction: TransactionContext): Promise<WriteReceipt> {
    const descriptor = await this.preparedStore.readCaptured(transaction.id);
    this.assertScope(prepared, transaction, descriptor);
    const snapshot = await this.loadSnapshot(descriptor);
    const state = await this.client(descriptor).apply({
      snapshot,
      ...(descriptor.header === undefined ? {} : { header: descriptor.header }),
      events: descriptor.events,
      ...(descriptor.workspaceId === undefined ? {} : { workspaceId: descriptor.workspaceId }),
      ...(descriptor.archived === undefined ? {} : { archived: descriptor.archived }),
    });
    return {
      transactionId: transaction.id,
      platform: "dsh",
      instanceId: descriptor.instanceId,
      targetKey: {
        platform: "dsh",
        instanceId: descriptor.instanceId,
        sessionId: descriptor.sessionId,
      },
      fingerprints: [fingerprint(descriptor.instanceId, descriptor.sessionId, state)],
      details: {
        planHash: descriptor.planHash,
        sessionId: descriptor.sessionId,
        stateDigest: state.digest,
      },
    };
  }

  async verify(
    receipt: WriteReceipt,
    _expected: PreparedWrite["expected"],
  ): Promise<VerificationResult> {
    const descriptor = await this.preparedStore.readCaptured(receipt.transactionId);
    const observed = await this.client(descriptor).observe(descriptor.workspaceId);
    const expectedDigest = receiptDigest(receipt);
    const ok = expectedDigest !== undefined && observed.before.digest === expectedDigest;
    return {
      ok,
      fingerprints: [fingerprint(descriptor.instanceId, descriptor.sessionId, observed.before)],
      issues: ok
        ? []
        : [{ code: "VERIFICATION_FAILED", message: "DSH Core state digest did not verify" }],
    };
  }

  async restore(backup: BackupManifest, transaction: TransactionContext): Promise<RestoreReceipt> {
    if (backup.transactionId !== transaction.id) {
      throw new SessionMaintenanceError("BACKUP_CORRUPT", "DSH backup transaction drifted");
    }
    const descriptor = await this.preparedStore.readCaptured(transaction.id);
    const store = this.backupStore(transaction.id);
    await store.verify(backup);
    const entry = backup.entries.find((item) => item.logicalName === "dsh-core-snapshot");
    if (
      entry === undefined ||
      !entry.required ||
      entry.objectId !== descriptor.snapshotEntry.objectId
    ) {
      throw new SessionMaintenanceError("BACKUP_INCOMPLETE", "DSH Core snapshot entry is missing");
    }
    const snapshot = snapshotFrom(await store.get(entry));
    if (snapshot.hash !== descriptor.snapshotHash) {
      throw new SessionMaintenanceError("BACKUP_CORRUPT", "DSH Core snapshot identity drifted");
    }
    const state = await this.client(descriptor).restore(snapshot);
    return {
      transactionId: transaction.id,
      restored: state.digest === snapshot.before.digest,
      fingerprints: [fingerprint(descriptor.instanceId, descriptor.sessionId, state)],
      issues: state.digest === snapshot.before.digest
        ? []
        : [{ code: "RESTORE_FAILED", message: "DSH Core state did not return to its snapshot" }],
    };
  }

  private client(descriptor: DshPreparedDescriptor) {
    return this.gateway.client({
      transactionId: descriptor.transactionId,
      planHash: descriptor.planHash,
      instanceId: descriptor.instanceId,
      sessionId: descriptor.sessionId,
    });
  }

  private backupStore(transactionId: string): TransactionBackupStore {
    return new TransactionBackupStore(join(this.stateRoot, "transactions", transactionId));
  }

  private async loadSnapshot(descriptor: DshPreparedCaptured): Promise<DshCoreSnapshot> {
    const snapshot = snapshotFrom(await this.backupStore(descriptor.transactionId).get(descriptor.snapshotEntry));
    if (snapshot.hash !== descriptor.snapshotHash) {
      throw new SessionMaintenanceError("BACKUP_CORRUPT", "DSH Core snapshot identity drifted");
    }
    return snapshot;
  }

  private assertScope(
    prepared: PreparedWrite,
    transaction: TransactionContext,
    descriptor: DshPreparedDescriptor,
  ): void {
    if (
      prepared.planId !== transaction.planId ||
      prepared.planHash !== transaction.planHash ||
      descriptor.transactionId !== transaction.id ||
      descriptor.planId !== transaction.planId ||
      descriptor.planHash !== transaction.planHash ||
      descriptor.instanceId !== prepared.instanceId ||
      descriptor.sessionId !== prepared.targetKey?.sessionId
    ) {
      throw new SessionMaintenanceError("IDENTITY_CONFLICT", "Prepared DSH write escaped transaction scope");
    }
  }
}
