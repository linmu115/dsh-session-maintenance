import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  SessionMaintenanceError,
  type BackupManifestEntry,
  type JsonValue,
  type NormalizedEvent,
} from "@linmu/dsh-session-contracts";
import type {
  DshNativeEvent,
  DshNativeSessionHeader,
} from "@linmu/dsh-core-extension";
import { canonicalJson, sha256Canonical } from "@linmu/dsh-session-domain";

export interface DshPreparedIntent {
  readonly schemaVersion: 1;
  readonly phase: "intent";
  readonly transactionId: string;
  readonly planId: string;
  readonly planHash: string;
  readonly instanceId: string;
  readonly sessionId: string;
  readonly sourceVersionId: string;
  readonly sourceBodyHash: string;
  readonly sourceEvents: readonly NormalizedEvent[];
  readonly create: boolean;
  readonly title?: string;
  readonly archived?: boolean;
  readonly workspaceId?: string;
  readonly hash: string;
}

export interface DshPreparedCaptured extends Omit<DshPreparedIntent, "phase" | "hash"> {
  readonly phase: "captured";
  readonly header?: DshNativeSessionHeader;
  readonly events: readonly DshNativeEvent[];
  readonly snapshotHash: string;
  readonly snapshotEntry: BackupManifestEntry;
  readonly hash: string;
}

export type DshPreparedDescriptor = DshPreparedIntent | DshPreparedCaptured;
type DescriptorPayload = Omit<DshPreparedDescriptor, "hash">;

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;

function descriptorHash(payload: DescriptorPayload): string {
  return `sha256:${sha256Canonical(payload as unknown as JsonValue)}`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }
}

function assertDescriptor(value: unknown): asserts value is DshPreparedDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SessionMaintenanceError("OBJECT_CORRUPT", "Prepared DSH descriptor is not an object");
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.schemaVersion !== 1 ||
    !["intent", "captured"].includes(String(raw.phase)) ||
    typeof raw.transactionId !== "string" ||
    typeof raw.planId !== "string" ||
    typeof raw.planHash !== "string" ||
    typeof raw.instanceId !== "string" ||
    typeof raw.sessionId !== "string" ||
    typeof raw.hash !== "string"
  ) {
    throw new SessionMaintenanceError("OBJECT_CORRUPT", "Prepared DSH descriptor fields are invalid");
  }
  const { hash, ...payload } = raw;
  if (hash !== descriptorHash(payload as DescriptorPayload)) {
    throw new SessionMaintenanceError("OBJECT_CORRUPT", "Prepared DSH descriptor hash mismatch");
  }
}

export class PreparedDshWriteStore {
  readonly stateRoot: string;

  constructor(stateRoot: string) {
    this.stateRoot = stateRoot;
  }

  async writeIntent(input: Omit<DshPreparedIntent, "hash">): Promise<DshPreparedIntent> {
    return this.write(input);
  }

  async writeCaptured(
    input: Omit<DshPreparedCaptured, "hash">,
  ): Promise<DshPreparedCaptured> {
    return this.write(input);
  }

  async read(transactionId: string): Promise<DshPreparedDescriptor> {
    const value = JSON.parse(await readFile(this.path(transactionId), "utf8")) as unknown;
    assertDescriptor(value);
    if (value.transactionId !== transactionId) {
      throw new SessionMaintenanceError("IDENTITY_CONFLICT", "Prepared DSH transaction ID drifted");
    }
    return value;
  }

  async readCaptured(transactionId: string): Promise<DshPreparedCaptured> {
    const value = await this.read(transactionId);
    if (value.phase !== "captured") {
      throw new SessionMaintenanceError("BACKUP_INCOMPLETE", "Prepared DSH write has no Core snapshot");
    }
    return value;
  }

  private async write<T extends DescriptorPayload>(payload: T): Promise<T & { readonly hash: string }> {
    const value = { ...payload, hash: descriptorHash(payload) };
    await atomicWrite(this.path(payload.transactionId), `${canonicalJson(value as unknown as JsonValue)}\n`);
    return value;
  }

  private path(transactionId: string): string {
    if (!SAFE_ID.test(transactionId)) {
      throw new SessionMaintenanceError("IDENTITY_CONFLICT", "Unsafe DSH transaction identity");
    }
    return join(this.stateRoot, "transactions", transactionId, "dsh-prepared.json");
  }
}
