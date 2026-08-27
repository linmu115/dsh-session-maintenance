import type {
  BackupManifest,
  PlatformWriteAdapter,
  PreparedWrite,
  PrepareWriteRequest,
  RegisteredInstance,
  RestoreReceipt,
  TransactionContext,
  VerificationResult,
  WriteProbe,
  WriteReceipt,
} from "@linmu/dsh-session-contracts";

export interface FakeWriteAdapterOptions {
  readonly verifyOk?: boolean;
  readonly restoreOk?: boolean;
  readonly faultAt?: "prepare" | "backup" | "commit" | "verify" | "restore";
}

export class FakeWriteAdapter implements PlatformWriteAdapter {
  readonly platform = "dsh" as const;
  readonly calls: string[] = [];
  readonly options: FakeWriteAdapterOptions;

  constructor(options: FakeWriteAdapterOptions = {}) {
    this.options = options;
  }

  async probeWrite(_instance: RegisteredInstance): Promise<WriteProbe> {
    this.calls.push("probe");
    return {
      status: "compatible",
      contract: {
        adapter: "fixture-read",
        platformVersion: "1.0.0",
        schemaFingerprint: "fixture-schema",
      },
      capabilities: ["append-events", "verify", "restore"],
      issues: [],
    };
  }

  async prepare(request: PrepareWriteRequest): Promise<PreparedWrite> {
    this.record("prepare");
    return {
      id: `prepared-${request.transaction.id}`,
      planId: request.plan.id,
      planHash: request.plan.hash,
      platform: "dsh",
      instanceId: request.instance.id,
      rootIdentity: request.instance.root,
      ...(request.plan.target === undefined ? {} : { targetKey: request.plan.target.key }),
      expected: { fingerprints: request.plan.preconditions },
      payload: {},
    };
  }

  async backup(
    _prepared: PreparedWrite,
    transaction: TransactionContext,
  ): Promise<BackupManifest> {
    this.record("backup");
    return {
      schemaVersion: 1,
      transactionId: transaction.id,
      entries: [],
      createdAt: transaction.startedAt,
      hash: "sha256:fixture-backup",
    };
  }

  async commit(
    prepared: PreparedWrite,
    transaction: TransactionContext,
  ): Promise<WriteReceipt> {
    this.record("commit");
    return {
      transactionId: transaction.id,
      platform: "dsh",
      instanceId: prepared.instanceId,
      ...(prepared.targetKey === undefined ? {} : { targetKey: prepared.targetKey }),
      fingerprints: prepared.expected.fingerprints,
      details: {},
    };
  }

  async verify(
    receipt: WriteReceipt,
    expected: PreparedWrite["expected"],
  ): Promise<VerificationResult> {
    this.record("verify");
    return {
      ok: this.options.verifyOk ?? true,
      fingerprints: receipt.fingerprints.length === 0 ? expected.fingerprints : receipt.fingerprints,
      issues: this.options.verifyOk === false ? [{ code: "VERIFY_FALSE", message: "fixture" }] : [],
    };
  }

  async restore(
    _backup: BackupManifest,
    transaction: TransactionContext,
  ): Promise<RestoreReceipt> {
    this.record("restore");
    return {
      transactionId: transaction.id,
      restored: this.options.restoreOk ?? true,
      fingerprints: [],
      issues: this.options.restoreOk === false ? [{ code: "RESTORE_FALSE", message: "fixture" }] : [],
    };
  }

  private record(step: Exclude<FakeWriteAdapterOptions["faultAt"], undefined>): void {
    this.calls.push(step);
    if (this.options.faultAt === step) throw new Error(`fake fault: ${step}`);
  }
}
