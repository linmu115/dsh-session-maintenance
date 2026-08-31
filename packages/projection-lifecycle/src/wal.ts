import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type {
  NativeAppendOperation,
  OperationId,
  ProjectionOperationReceipt,
} from "@linmu/dsh-session-contracts";

export interface ProjectionWalRecord {
  readonly schemaVersion: 1;
  readonly operation: NativeAppendOperation;
  readonly state: "pending" | "committed";
  readonly projectionApplied: boolean;
  readonly receipt: ProjectionOperationReceipt | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sameOperation(left: NativeAppendOperation, right: NativeAppendOperation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function durableWrite(path: string, value: unknown, exclusive: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (exclusive) {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class ProjectionWriteAheadLog {
  readonly root: string;

  constructor(projectionRoot: string) {
    this.root = resolve(projectionRoot, "..", "wal");
  }

  async get(operationId: OperationId): Promise<ProjectionWalRecord | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.path(operationId), "utf8")) as ProjectionWalRecord;
      if (parsed.schemaVersion !== 1 || parsed.operation.operationId !== operationId) {
        throw new TypeError(`Projection WAL record is invalid: ${operationId}`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(): Promise<readonly ProjectionWalRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: ProjectionWalRecord[] = [];
    for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
      const parsed = JSON.parse(await readFile(join(this.root, name), "utf8")) as ProjectionWalRecord;
      if (parsed.schemaVersion !== 1 || typeof parsed.operation?.operationId !== "string") {
        throw new TypeError(`Projection WAL record is invalid: ${name}`);
      }
      records.push(parsed);
    }
    return records;
  }

  async pending(): Promise<readonly ProjectionWalRecord[]> {
    return (await this.list()).filter((record) => record.state === "pending");
  }

  async putPending(operation: NativeAppendOperation, at: string): Promise<ProjectionWalRecord> {
    const existing = await this.get(operation.operationId);
    if (existing !== undefined) {
      if (!sameOperation(existing.operation, operation)) {
        throw new Error(`Operation ID already has different WAL content: ${operation.operationId}`);
      }
      return existing;
    }
    const record: ProjectionWalRecord = {
      schemaVersion: 1,
      operation,
      state: "pending",
      projectionApplied: false,
      receipt: null,
      createdAt: at,
      updatedAt: at,
    };
    await durableWrite(this.path(operation.operationId), record, true);
    return record;
  }

  async markProjectionApplied(operationId: OperationId, at: string): Promise<ProjectionWalRecord> {
    const current = await this.required(operationId);
    if (current.projectionApplied) return current;
    return this.replace({ ...current, projectionApplied: true, updatedAt: at });
  }

  async markCommitted(
    operationId: OperationId,
    receipt: ProjectionOperationReceipt,
    at: string,
  ): Promise<ProjectionWalRecord> {
    const current = await this.required(operationId);
    if (!current.projectionApplied) {
      throw new Error(`Cannot commit WAL before projection update: ${operationId}`);
    }
    if (current.receipt !== null && JSON.stringify(current.receipt) !== JSON.stringify(receipt)) {
      throw new Error(`WAL receipt changed for operation: ${operationId}`);
    }
    return this.replace({ ...current, state: "committed", receipt, updatedAt: at });
  }

  private async required(operationId: OperationId): Promise<ProjectionWalRecord> {
    const record = await this.get(operationId);
    if (record === undefined) throw new Error(`Projection WAL record not found: ${operationId}`);
    return record;
  }

  private async replace(record: ProjectionWalRecord): Promise<ProjectionWalRecord> {
    await durableWrite(this.path(record.operation.operationId), record, false);
    return record;
  }

  private path(operationId: OperationId): string {
    return join(this.root, `${encoded(operationId)}.json`);
  }
}
