import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

import {
  SessionMaintenanceError,
  type AdapterContractRef,
  type ApplyPlanRequest,
  type BackupManifest,
  type JsonValue,
  type PlatformKind,
  type PlatformWriteAdapter,
  type RegisteredInstance,
  type RestoreTransactionRequest,
  type SyncPlan,
  type TransactionContext,
  type TransactionRecord,
  type TransactionRef,
  type TransactionRepository,
  type TransactionStatus,
} from "@linmu/dsh-session-contracts";
import { canonicalJson, validatePlanPreconditions } from "@linmu/dsh-session-domain";

import { AppendOnlyJournal } from "./journal.js";
import { ConfirmationService } from "./confirmation.js";
import { RootWriteLockManager } from "./lock-manager.js";

export interface TransactionExecutorDependencies {
  readonly stateRoot: string;
  readonly repository: TransactionRepository;
  readonly adapters: ReadonlyMap<PlatformKind, PlatformWriteAdapter>;
  readonly instances: ReadonlyMap<string, RegisteredInstance>;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly lockManager?: RootWriteLockManager;
  readonly confirmationService?: ConfirmationService;
  readFingerprints(plan: SyncPlan): Promise<SyncPlan["preconditions"]>;
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function errorCode(error: unknown): string {
  if (error instanceof SessionMaintenanceError) return error.code;
  return "WRITE_CAPABILITY_UNAVAILABLE";
}

function transactionRef(record: TransactionRecord): TransactionRef {
  return { id: record.id, status: record.status };
}

function targetInstanceId(plan: SyncPlan): string {
  if (plan.target !== undefined) return plan.target.key.instanceId;
  const create = plan.operations.find((operation) => operation.type === "create-target-session");
  if (create?.type === "create-target-session") return create.targetInstanceId;
  throw new SessionMaintenanceError(
    "WRITE_CAPABILITY_UNAVAILABLE",
    `Plan has no writable DSH target: ${plan.id}`,
  );
}

async function persistPlanFile(path: string, plan: SyncPlan): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  const serialized = `${canonicalJson(plan as unknown as JsonValue)}\n`;
  try {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    if (code !== "EEXIST" || (await readFile(path, "utf8")) !== serialized) throw error;
  }
}

export async function recordTransition(
  repository: TransactionRepository,
  journal: AppendOnlyJournal,
  input: {
    readonly transactionId: string;
    readonly status: TransactionStatus;
    readonly step: string;
    readonly at: string;
    readonly data?: JsonValue;
    readonly result?: JsonValue;
    readonly errorCode?: string;
  },
): Promise<TransactionRecord> {
  const entry = await journal.append({
    transactionId: input.transactionId,
    status: input.status,
    step: input.step,
    at: input.at,
    data: input.data ?? {},
  });
  return repository.recordTransactionStep({
    step: entry,
    ...(input.result === undefined ? {} : { result: input.result }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
  });
}

export class TransactionExecutor {
  readonly stateRoot: string;
  readonly repository: TransactionRepository;
  readonly adapters: ReadonlyMap<PlatformKind, PlatformWriteAdapter>;
  readonly instances: ReadonlyMap<string, RegisteredInstance>;
  readonly now: () => Date;
  readonly idFactory: () => string;
  readonly lockManager: RootWriteLockManager;
  readonly confirmationService: ConfirmationService | undefined;
  readFingerprints: TransactionExecutorDependencies["readFingerprints"];

  constructor(dependencies: TransactionExecutorDependencies) {
    this.stateRoot = dependencies.stateRoot;
    this.repository = dependencies.repository;
    this.adapters = dependencies.adapters;
    this.instances = dependencies.instances;
    this.readFingerprints = dependencies.readFingerprints;
    this.now = dependencies.now ?? (() => new Date());
    this.idFactory = dependencies.idFactory ?? (() => `tx_${randomUUID().replaceAll("-", "")}`);
    this.lockManager =
      dependencies.lockManager ?? new RootWriteLockManager(join(this.stateRoot, "locks"));
    this.confirmationService = dependencies.confirmationService;
  }

  async apply(request: ApplyPlanRequest): Promise<TransactionRef> {
    const plan = await this.repository.getPlan(request.planId);
    if (plan === undefined) {
      throw new SessionMaintenanceError("OBJECT_CORRUPT", `Sync plan not found: ${request.planId}`);
    }
    const existing = await this.repository.findTransactionByPlan(plan.id, plan.hash);
    if (existing !== undefined) return transactionRef(existing);
    if (plan.risk !== "safe" || plan.operations.some((operation) => operation.type === "require-review")) {
      throw new SessionMaintenanceError(
        "WRITE_CAPABILITY_UNAVAILABLE",
        `Plan is not executable as a safe phase-two write: ${plan.id}`,
      );
    }

    const instanceId = targetInstanceId(plan);
    const instance = this.instances.get(instanceId);
    if (instance === undefined || instance.platform !== "dsh") {
      throw new SessionMaintenanceError(
        "WRITE_CAPABILITY_UNAVAILABLE",
        `Registered DSH instance not found: ${instanceId}`,
      );
    }
    const adapter = this.adapters.get("dsh");
    if (adapter === undefined) {
      throw new SessionMaintenanceError(
        "WRITE_CAPABILITY_UNAVAILABLE",
        "No DSH write Adapter is registered",
      );
    }
    const probe = await adapter.probeWrite(instance);
    if (
      probe.status !== "compatible" ||
      !plan.adapterContracts.some(
        (contract) =>
          contract.adapter === probe.contract.adapter &&
          contract.platformVersion === probe.contract.platformVersion &&
          contract.schemaFingerprint === probe.contract.schemaFingerprint,
      )
    ) {
      throw new SessionMaintenanceError(
        "ADAPTER_INCOMPATIBLE",
        `DSH write Adapter contract does not match plan: ${plan.id}`,
      );
    }
    validatePlanPreconditions(plan, await this.readFingerprints(plan));

    const rootIdentity = resolve(instance.root).toLocaleLowerCase("en-US");
    return this.lockManager.withLock(instance.id, rootIdentity, async () => {
      const concurrent = await this.repository.findTransactionByPlan(plan.id, plan.hash);
      if (concurrent !== undefined) return transactionRef(concurrent);
      for (const protection of await this.repository.listBackupProtections()) {
        if (!protection.reasons.includes("unresolved-transaction")) continue;
        const unresolved = await this.repository.getTransaction(protection.transactionId);
        if (
          unresolved !== undefined &&
          unresolved.instanceId === instance.id &&
          unresolved.rootIdentity === rootIdentity
        ) {
          throw new SessionMaintenanceError(
            "RECOVERY_REQUIRED",
            `Unresolved transaction blocks this DSH root: ${unresolved.id}`,
          );
        }
      }
      return this.applyLocked(plan, instance, adapter, probe.contract, rootIdentity);
    });
  }

  async restoreScope(transactionId: string): Promise<{
    readonly operation: "restore";
    readonly resourceId: string;
    readonly operationHash: string;
  }> {
    const transaction = await this.repository.getTransaction(transactionId);
    const backup = await this.repository.getBackupManifest(transactionId);
    if (
      transaction === undefined ||
      backup === undefined ||
      !["completed", "restored"].includes(transaction.status)
    ) {
      throw new SessionMaintenanceError(
        "TRANSACTION_NOT_RESTORABLE",
        `Transaction has no usable backup: ${transactionId}`,
      );
    }
    return {
      operation: "restore",
      resourceId: transactionId,
      operationHash: `sha256:${createHash("sha256")
        .update(canonicalJson({ transactionId, backupHash: backup.hash }))
        .digest("hex")}`,
    };
  }

  async restore(request: RestoreTransactionRequest): Promise<TransactionRef> {
    if (this.confirmationService === undefined) {
      throw new SessionMaintenanceError(
        "CONFIRMATION_REQUIRED",
        "No confirmation service is configured",
      );
    }
    const scope = await this.restoreScope(request.transactionId);
    await this.confirmationService.consumeToken(request.confirmationToken, scope);
    const transaction = await this.repository.getTransaction(request.transactionId);
    const backup = await this.repository.getBackupManifest(request.transactionId);
    if (transaction === undefined || backup === undefined || transaction.status !== "completed") {
      if (transaction?.status === "restored") return transactionRef(transaction);
      throw new SessionMaintenanceError(
        "TRANSACTION_NOT_RESTORABLE",
        `Transaction cannot be restored from state: ${transaction?.status ?? "missing"}`,
      );
    }
    const adapter = this.adapters.get(transaction.platform);
    const instance = this.instances.get(transaction.instanceId);
    if (adapter === undefined || instance === undefined) {
      throw new SessionMaintenanceError(
        "WRITE_CAPABILITY_UNAVAILABLE",
        `Restore Adapter or instance is unavailable: ${transaction.id}`,
      );
    }
    const probe = await adapter.probeWrite(instance);
    if (
      probe.status !== "compatible" ||
      canonicalJson(probe.contract as unknown as JsonValue) !==
        canonicalJson(transaction.adapterContract as unknown as JsonValue)
    ) {
      throw new SessionMaintenanceError(
        "ADAPTER_INCOMPATIBLE",
        `Restore Adapter contract drifted: ${transaction.id}`,
      );
    }
    return this.lockManager.withLock(transaction.instanceId, transaction.rootIdentity, async () => {
      const current = await this.repository.getTransaction(transaction.id);
      if (current?.status === "restored") return transactionRef(current);
      if (current?.status !== "completed") {
        throw new SessionMaintenanceError(
          "TRANSACTION_NOT_RESTORABLE",
          `Transaction changed before restore: ${current?.status ?? "missing"}`,
        );
      }
      const context: TransactionContext = {
        id: current.id,
        planId: current.planId,
        planHash: current.planHash,
        startedAt: current.createdAt,
      };
      const journal = new AppendOnlyJournal(
        join(this.stateRoot, "transactions", current.id, "journal.jsonl"),
      );
      return this.restoreOnce(adapter, backup, context, journal, "explicit-restore");
    });
  }

  private async applyLocked(
    plan: SyncPlan,
    instance: RegisteredInstance,
    adapter: PlatformWriteAdapter,
    adapterContract: AdapterContractRef,
    rootIdentity: string,
  ): Promise<TransactionRef> {
    const at = this.now().toISOString();
    const transaction: TransactionContext = {
      id: this.idFactory(),
      planId: plan.id,
      planHash: plan.hash,
      startedAt: at,
    };
    const directory = join(this.stateRoot, "transactions", transaction.id);
    await persistPlanFile(join(directory, "plan.json"), plan);
    let record = await this.repository.createTransaction({
      id: transaction.id,
      planId: plan.id,
      planHash: plan.hash,
      platform: "dsh",
      instanceId: instance.id,
      rootIdentity,
      adapterContract,
      status: "prepared",
      createdAt: at,
      updatedAt: at,
    });
    const journal = new AppendOnlyJournal(join(directory, "journal.jsonl"));
    record = await recordTransition(this.repository, journal, {
      transactionId: transaction.id,
      status: "prepared",
      step: "transaction-created",
      at,
    });

    let commitStarted = false;
    let backup: BackupManifest | undefined;
    try {
      const prepared = await adapter.prepare({ plan, instance, transaction });
      record = await recordTransition(this.repository, journal, {
        transactionId: transaction.id,
        status: "backing-up",
        step: "backup-started",
        at: this.now().toISOString(),
      });
      backup = await adapter.backup(prepared, transaction);
      if (backup.transactionId !== transaction.id) {
        throw new SessionMaintenanceError("BACKUP_CORRUPT", "Adapter returned another transaction backup");
      }
      await this.repository.saveBackupManifest(backup);
      record = await recordTransition(this.repository, journal, {
        transactionId: transaction.id,
        status: "applying",
        step: "backup-completed",
        at: this.now().toISOString(),
        data: { backupHash: backup.hash, entries: backup.entries.length },
      });
      commitStarted = true;
      const receipt = await adapter.commit(prepared, transaction);
      record = await recordTransition(this.repository, journal, {
        transactionId: transaction.id,
        status: "verifying",
        step: "commit-completed",
        at: this.now().toISOString(),
      });
      const verification = await adapter.verify(receipt, prepared.expected);
      if (verification.ok) {
        record = await recordTransition(this.repository, journal, {
          transactionId: transaction.id,
          status: "completed",
          step: "verification-completed",
          at: this.now().toISOString(),
          result: asJsonValue(receipt),
        });
        return transactionRef(record);
      }
      return this.restoreOnce(
        adapter,
        backup,
        transaction,
        journal,
        "verification-failed",
        new SessionMaintenanceError("VERIFICATION_FAILED", "Write verification failed", {
          details: { issues: verification.issues.map((issue) => issue.code) },
        }),
      );
    } catch (error) {
      if (commitStarted && backup !== undefined) {
        return this.restoreOnce(
          adapter,
          backup,
          transaction,
          journal,
          "write-threw-after-commit-start",
          error,
        );
      }
      await recordTransition(this.repository, journal, {
        transactionId: transaction.id,
        status: "manual-review",
        step: "write-aborted-before-commit",
        at: this.now().toISOString(),
        errorCode: errorCode(error),
      });
      throw error;
    }
  }

  private async restoreOnce(
    adapter: PlatformWriteAdapter,
    backup: BackupManifest,
    transaction: TransactionContext,
    journal: AppendOnlyJournal,
    trigger: string,
    originalError?: unknown,
  ): Promise<TransactionRef> {
    await recordTransition(this.repository, journal, {
      transactionId: transaction.id,
      status: "restoring",
      step: trigger,
      at: this.now().toISOString(),
      ...(originalError === undefined ? {} : { errorCode: errorCode(originalError) }),
    });
    try {
      const restored = await adapter.restore(backup, transaction);
      const record = await recordTransition(this.repository, journal, {
        transactionId: transaction.id,
        status: restored.restored ? "restored" : "restore-failed",
        step: restored.restored ? "restore-completed" : "restore-failed",
        at: this.now().toISOString(),
        result: asJsonValue(restored),
        ...(restored.restored ? {} : { errorCode: "RESTORE_FAILED" }),
      });
      return transactionRef(record);
    } catch (restoreError) {
      const record = await recordTransition(this.repository, journal, {
        transactionId: transaction.id,
        status: "restore-failed",
        step: "restore-threw",
        at: this.now().toISOString(),
        errorCode: "RESTORE_FAILED",
        data: {
          ...(originalError === undefined ? {} : { original: errorCode(originalError) }),
          restore: errorCode(restoreError),
        },
      });
      return transactionRef(record);
    }
  }
}
