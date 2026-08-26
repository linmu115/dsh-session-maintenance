import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import {
  constants as zlibConstants,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";

import {
  SessionMaintenanceError,
  type ContentObjectStore,
  type GcPolicy,
  type GcReport,
} from "@linmu/dsh-session-contracts";

const OBJECT_ID = /^sha256:([0-9a-f]{64})$/u;
const MAX_OBJECT_BYTES = 256 * 1024 * 1024;

function sha256(bytes: Uint8Array): string {
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

export class ZstdContentObjectStore implements ContentObjectStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async put(bytes: Uint8Array): Promise<string> {
    const hex = sha256(bytes);
    const id = `sha256:${hex}`;
    const target = this.pathForHex(hex);

    try {
      await this.get(id);
      return id;
    } catch (error) {
      if (!isNotFound((error as { readonly cause?: unknown }).cause)) {
        throw error;
      }
    }

    const directory = join(this.root, "objects", "sha256", hex.slice(0, 2));
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `.${hex}.${process.pid}.${randomUUID()}.tmp`);
    const compressed = zstdCompressSync(bytes, {
      params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 },
    });
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(compressed);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await rename(temporary, target);
    } catch (error) {
      try {
        await this.get(id);
      } catch {
        throw error;
      }
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isNotFound(error)) {
          throw error;
        }
      });
    }

    await this.get(id);
    return id;
  }

  async get(id: string): Promise<Uint8Array> {
    const match = OBJECT_ID.exec(id);
    if (match === null) {
      throw new SessionMaintenanceError("OBJECT_CORRUPT", `Invalid content object ID: ${id}`);
    }

    const hex = match[1];
    if (hex === undefined) {
      throw new SessionMaintenanceError("OBJECT_CORRUPT", `Invalid content object ID: ${id}`);
    }

    try {
      const compressed = await readFile(this.pathForHex(hex));
      const bytes = zstdDecompressSync(compressed, { maxOutputLength: MAX_OBJECT_BYTES });
      if (sha256(bytes) !== hex) {
        throw new Error("Uncompressed content hash mismatch");
      }
      return bytes;
    } catch (error) {
      throw new SessionMaintenanceError("OBJECT_CORRUPT", `Content object failed verification: ${id}`, {
        cause: error,
      });
    }
  }

  async collect(policy: GcPolicy): Promise<GcReport> {
    const reachable = new Set(policy.reachableObjectIds);
    const cutoff = policy.olderThan === undefined ? undefined : new Date(policy.olderThan).getTime();
    if (cutoff !== undefined && !Number.isFinite(cutoff)) {
      throw new TypeError(`Invalid GC cutoff: ${policy.olderThan}`);
    }

    let reachableObjects = 0;
    let retainedObjects = 0;
    let deletedObjects = 0;
    let deletedBytes = 0;
    const base = join(this.root, "objects", "sha256");
    let prefixes;
    try {
      prefixes = await readdir(base, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) {
        return { reachableObjects, retainedObjects, deletedObjects, deletedBytes };
      }
      throw error;
    }

    for (const prefix of prefixes) {
      if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/u.test(prefix.name)) {
        continue;
      }
      const directory = join(base, prefix.name);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[0-9a-f]{62}\.zst$/u.test(entry.name)) {
          continue;
        }
        const path = join(directory, entry.name);
        const info = await stat(path);
        const id = `sha256:${prefix.name}${entry.name.slice(0, -4)}`;
        if (reachable.has(id)) {
          reachableObjects += 1;
          retainedObjects += 1;
          continue;
        }
        if (cutoff !== undefined && info.mtimeMs >= cutoff) {
          retainedObjects += 1;
          continue;
        }

        deletedObjects += 1;
        deletedBytes += info.size;
        if (!policy.dryRun) {
          await unlink(path);
        }
      }
    }

    return { reachableObjects, retainedObjects, deletedObjects, deletedBytes };
  }

  private pathForHex(hex: string): string {
    return join(this.root, "objects", "sha256", hex.slice(0, 2), `${hex.slice(2)}.zst`);
  }
}
