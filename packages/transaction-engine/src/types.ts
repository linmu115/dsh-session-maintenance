import type { JsonValue, TransactionStatus } from "@linmu/dsh-session-contracts";

export interface JournalEntryInput {
  readonly transactionId: string;
  readonly status: TransactionStatus;
  readonly step: string;
  readonly at: string;
  readonly data: JsonValue;
}

export interface TransactionExecutorOptions {
  readonly stateRoot: string;
}
