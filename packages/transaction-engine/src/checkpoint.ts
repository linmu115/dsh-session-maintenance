import { createHash } from "node:crypto";

import {
  createCheckpointRequestSchema,
  type BackupProtection,
  type Checkpoint,
  type CreateCheckpointRequest,
  type TransactionRepository,
} from "@linmu/dsh-session-contracts";
import { canonicalJson } from "@linmu/dsh-session-domain";

export class CheckpointService {
  readonly repository: TransactionRepository;

  constructor(repository: TransactionRepository) {
    this.repository = repository;
  }

  async create(request: CreateCheckpointRequest): Promise<Checkpoint> {
    const valid = createCheckpointRequestSchema.parse(request) as CreateCheckpointRequest;
    const identity = canonicalJson({
      name: valid.name,
      description: valid.description,
      refs: valid.refs,
      backupTransactionIds: [...valid.backupTransactionIds].sort(),
      createdBy: valid.createdBy,
      createdAt: valid.createdAt,
    });
    const id = `checkpoint_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
    const checkpoint: Checkpoint = {
      id,
      ...valid,
      backupTransactionIds: [...valid.backupTransactionIds].sort(),
    };
    await this.repository.saveCheckpoint(checkpoint);
    return (await this.repository.getCheckpoint(id))!;
  }

  protections(): Promise<readonly BackupProtection[]> {
    return this.repository.listBackupProtections();
  }
}
