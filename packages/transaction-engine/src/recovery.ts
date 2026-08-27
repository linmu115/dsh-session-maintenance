import { join } from "node:path";

import {
  SessionMaintenanceError,
  type JsonValue,
  type PlatformKind,
  type PlatformWriteAdapter,
  type TransactionContext,
  type TransactionRecord,
  type TransactionRef,
  type TransactionRepository,
  type WriteReceipt,
} from "@linmu/dsh-session-contracts";
import { canonicalJson } from "@linmu/dsh-session-domain";

import { recordTransition } from "./executor.js";
import { AppendOnlyJournal } from "./journal.js";
import { RootWriteLockManager } from "./lock-manager.js";

export interface TransactionRecoveryDependencies {
  readonly stateRoot: string;
  readonly repository: TransactionRepository;
  readonly adapters: ReadonlyMap<PlatformKind, PlatformWriteAdapter>;
  readonly now?: () => Date;
  readonly lockManager?: RootWriteLockManager;
}

function ref(record: TransactionRecord): TransactionRef {
  return { id: record.id, status: record.status };
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export class TransactionRecovery {
  readonly stateRoot: string;
  readonly repository: TransactionRepository;
  readonly adapters: ReadonlyMap<PlatformKind, PlatformWriteAdapter>;
  readonly now: () => Date;
  readonly lockManager: RootWriteLockManager;

  constructor(dependencies: TransactionRecoveryDependencies) {
    this.stateRoot = dependencies.stateRoot;
    this.repository = dependencies.repository;
    this.adapters = dependencies.adapters;
    this.now = dependencies.now ?? (() => new Date());
    this.lockManager =
      dependencies.lockManager ?? new RootWriteLockManager(join(this.stateRoot, "locks"));
  }

  async recover(transactionId: string): Promise<TransactionRef> {
    const transaction = await this.repository.getTransaction(transactionId);
    if (transaction === undefined) {
      throw new SessionMaintenanceError(
        "TRANSACTION_NOT_FOUND",
        `Transaction not found: ${transactionId}`,
      );
    }
    if (["completed", "restored", "restore-failed", "manual-review"].includes(transaction.status)) {
      return ref(transaction);
    }
    try {
      return await this.lockManager.withLock(transaction.instanceId, transaction.rootIdentity, () =>
        this.recoverLocked(transactionId),
      );
    } catch (error) {
      if (!(error instanceof SessionMaintenanceError) || error.code !== "TRANSACTION_IN_PROGRESS") {
        throw error;
      }
      await this.lockManager.clearStaleLockAfterInspection(
        transaction.instanceId,
        transaction.rootIdentity,
        () => this.journalAndDatabaseAgree(transaction),
      );
      return this.lockManager.withLock(transaction.instanceId, transaction.rootIdentity, () =>
        this.recoverLocked(transactionId),
      );
    }
  }

  private async recoverLocked(transactionId: string): Promise<TransactionRef> {
    let transaction = await this.repository.getTransaction(transactionId);
    if (transaction === undefined) {
      throw new SessionMaintenanceError(
        "TRANSACTION_NOT_FOUND",
        `Transaction not found: ${transactionId}`,
      );
    }
    if (["completed", "restored", "restore-failed", "manual-review"].includes(transaction.status)) {
      return ref(transaction);
    }
    const plan = await this.repository.getPlan(transaction.planId);
    if (plan === undefined || plan.hash !== transaction.planHash) {
      throw new SessionMaintenanceError("OBJECT_CORRUPT", `Transaction plan is unavailable: ${transactionId}`);
    }
    const adapter = this.adapters.get(transaction.platform);
    if (adapter === undefined) {
      throw new SessionMaintenanceError(
        "WRITE_CAPABILITY_UNAVAILABLE",
        `No recovery Adapter for platform: ${transaction.platform}`,
      );
    }
    const journal = new AppendOnlyJournal(
      join(this.stateRoot, "transactions", transaction.id, "journal.jsonl"),
    );
    transaction = await this.reconcileJournal(transaction, journal);
    if (transaction.status === "manual-review") return ref(transaction);
    const context: TransactionContext = {
      id: transaction.id,
      planId: transaction.planId,
      planHash: transaction.planHash,
      startedAt: transaction.createdAt,
    };

    if (["prepared", "backing-up"].includes(transaction.status)) {
      transaction = await recordTransition(this.repository, journal, {
        transactionId,
        status: "manual-review",
        step: "recovery-found-pre-commit-transaction",
        at: this.now().toISOString(),
        errorCode: "RECOVERY_REQUIRED",
      });
      return ref(transaction);
    }

    const receipt: WriteReceipt = {
      transactionId,
      platform: "dsh",
      instanceId: transaction.instanceId,
      ...(plan.target === undefined ? {} : { targetKey: plan.target.key }),
      fingerprints: plan.preconditions,
      details: { recovery: true },
    };
    if (["applying", "verifying"].includes(transaction.status)) {
      const verification = await adapter.verify(receipt, { fingerprints: plan.preconditions });
      if (verification.ok) {
        transaction = await recordTransition(this.repository, journal, {
          transactionId,
          status: "completed",
          step: "recovery-verification-completed",
          at: this.now().toISOString(),
          result: asJsonValue(receipt),
        });
        return ref(transaction);
      }
      transaction = await recordTransition(this.repository, journal, {
        transactionId,
        status: "restoring",
        step: "recovery-verification-failed",
        at: this.now().toISOString(),
        errorCode: "VERIFICATION_FAILED",
      });
    }

    const backup = await this.repository.getBackupManifest(transactionId);
    if (backup === undefined) {
      transaction = await recordTransition(this.repository, journal, {
        transactionId,
        status: "manual-review",
        step: "recovery-backup-missing",
        at: this.now().toISOString(),
        errorCode: "BACKUP_INCOMPLETE",
      });
      return ref(transaction);
    }
    try {
      const restored = await adapter.restore(backup, context);
      transaction = await recordTransition(this.repository, journal, {
        transactionId,
        status: restored.restored ? "restored" : "restore-failed",
        step: restored.restored ? "recovery-restore-completed" : "recovery-restore-failed",
        at: this.now().toISOString(),
        result: asJsonValue(restored),
        ...(restored.restored ? {} : { errorCode: "RESTORE_FAILED" }),
      });
      return ref(transaction);
    } catch (error) {
      transaction = await recordTransition(this.repository, journal, {
        transactionId,
        status: "restore-failed",
        step: "recovery-restore-threw",
        at: this.now().toISOString(),
        errorCode: "RESTORE_FAILED",
      });
      return ref(transaction);
    }
  }

  private async reconcileJournal(
    transaction: TransactionRecord,
    journal: AppendOnlyJournal,
  ): Promise<TransactionRecord> {
    let journalSteps;
    try {
      journalSteps = await journal.read();
    } catch {
      return this.repository.markTransactionManualReview(
        transaction.id,
        this.now().toISOString(),
        "OBJECT_CORRUPT",
      );
    }
    const databaseSteps = await this.repository.listTransactionSteps(transaction.id);
    const shared = Math.min(journalSteps.length, databaseSteps.length);
    for (let index = 0; index < shared; index += 1) {
      if (
        canonicalJson(journalSteps[index] as unknown as JsonValue) !==
        canonicalJson(databaseSteps[index] as unknown as JsonValue)
      ) {
        return this.repository.markTransactionManualReview(
          transaction.id,
          this.now().toISOString(),
          "OBJECT_CORRUPT",
        );
      }
    }
    if (databaseSteps.length > journalSteps.length) {
      return this.repository.markTransactionManualReview(
        transaction.id,
        this.now().toISOString(),
        "OBJECT_CORRUPT",
      );
    }
    for (const step of journalSteps.slice(databaseSteps.length)) {
      if (step.transactionId !== transaction.id) {
        return this.repository.markTransactionManualReview(
          transaction.id,
          this.now().toISOString(),
          "OBJECT_CORRUPT",
        );
      }
      transaction = await this.repository.recordTransactionStep({ step });
    }
    return transaction;
  }

  private async journalAndDatabaseAgree(transaction: TransactionRecord): Promise<boolean> {
    try {
      const journal = new AppendOnlyJournal(
        join(this.stateRoot, "transactions", transaction.id, "journal.jsonl"),
      );
      const journalSteps = await journal.read();
      const databaseSteps = await this.repository.listTransactionSteps(transaction.id);
      if (databaseSteps.length > journalSteps.length) return false;
      return databaseSteps.every(
        (step, index) =>
          journalSteps[index]?.transactionId === transaction.id &&
          canonicalJson(step as unknown as JsonValue) ===
            canonicalJson(journalSteps[index] as unknown as JsonValue),
      );
    } catch {
      return false;
    }
  }
}
