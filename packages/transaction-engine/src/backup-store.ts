import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  SessionMaintenanceError,
  backupManifestSchema,
  type BackupManifest,
  type BackupManifestEntry,
  type JsonValue,
} from "@linmu/dsh-session-contracts";
import { canonicalJson } from "@linmu/dsh-session-domain";

const OBJECT_ID = /^sha256:([0-9a-f]{64})$/u;
type JsonObject = { readonly [key: string]: JsonValue };

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

async function atomicWrite(path: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await flushDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }
}

async function flushDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    if (!["EISDIR", "EINVAL", "EPERM", "ENOTSUP"].includes(String(code))) throw error;
  }
}

function manifestPayload(
  transactionId: string,
  entries: readonly BackupManifestEntry[],
  createdAt: string,
): JsonObject {
  return {
    schemaVersion: 1,
    transactionId,
    entries: entries.map((entry) => ({
      logicalName: entry.logicalName,
      objectId: entry.objectId,
      size: entry.size,
      sha256: entry.sha256,
      required: entry.required,
    })),
    createdAt,
  };
}

export class TransactionBackupStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async put(
    logicalName: string,
    bytes: Uint8Array,
    required: boolean,
  ): Promise<BackupManifestEntry> {
    if (logicalName.trim() === "") throw new TypeError("Backup logical name is required");
    const hex = sha256(bytes);
    const objectId = `sha256:${hex}`;
    const path = this.pathFor(objectId);
    try {
      const existing = await readFile(path);
      if (sha256(existing) !== hex) throw new Error("existing backup hash mismatch");
    } catch (error) {
      if (!isNotFound(error)) {
        throw new SessionMaintenanceError("BACKUP_CORRUPT", `Backup object is corrupt: ${objectId}`, {
          cause: error,
        });
      }
      await atomicWrite(path, bytes);
    }
    return { logicalName, objectId, size: bytes.byteLength, sha256: hex, required };
  }

  async finalize(
    transactionId: string,
    entries: readonly BackupManifestEntry[],
    createdAt: string,
  ): Promise<BackupManifest> {
    if (new Set(entries.map((entry) => entry.logicalName)).size !== entries.length) {
      throw new SessionMaintenanceError("BACKUP_INCOMPLETE", "Backup logical names must be unique");
    }
    const payload = manifestPayload(transactionId, entries, createdAt);
    const manifest = backupManifestSchema.parse({
      ...payload,
      hash: `sha256:${sha256(canonicalJson(payload))}`,
    }) as BackupManifest;
    await this.verify(manifest);
    await atomicWrite(
      join(this.root, "backup-manifest.json"),
      `${canonicalJson(manifest as unknown as JsonValue)}\n`,
    );
    return manifest;
  }

  async verify(manifest: BackupManifest): Promise<BackupManifest> {
    backupManifestSchema.parse(manifest);
    const expectedHash = `sha256:${sha256(
      canonicalJson(manifestPayload(manifest.transactionId, manifest.entries, manifest.createdAt)),
    )}`;
    if (manifest.hash !== expectedHash) {
      throw new SessionMaintenanceError("BACKUP_CORRUPT", "Backup manifest hash mismatch");
    }
    for (const entry of manifest.entries) {
      try {
        const bytes = await readFile(this.pathFor(entry.objectId));
        if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256) {
          throw new Error("backup bytes mismatch");
        }
      } catch (error) {
        if (!entry.required && isNotFound(error)) continue;
        throw new SessionMaintenanceError(
          isNotFound(error) ? "BACKUP_INCOMPLETE" : "BACKUP_CORRUPT",
          `Backup object failed verification: ${entry.logicalName}`,
          { cause: error },
        );
      }
    }
    return manifest;
  }

  async get(entry: BackupManifestEntry): Promise<Uint8Array> {
    try {
      const bytes = await readFile(this.pathFor(entry.objectId));
      if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256) {
        throw new Error("backup bytes mismatch");
      }
      return bytes;
    } catch (error) {
      throw new SessionMaintenanceError(
        isNotFound(error) ? "BACKUP_INCOMPLETE" : "BACKUP_CORRUPT",
        `Backup object failed retrieval: ${entry.logicalName}`,
        { cause: error },
      );
    }
  }

  pathFor(objectId: string): string {
    const match = OBJECT_ID.exec(objectId);
    if (match === null || match[1] === undefined) {
      throw new SessionMaintenanceError("BACKUP_CORRUPT", `Invalid backup object ID: ${objectId}`);
    }
    const hex = match[1];
    return join(this.root, "backups", "sha256", hex.slice(0, 2), hex.slice(2));
  }
}
