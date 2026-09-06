import { copyFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { isMissing } from "./retention-paths.js";

/** SQLite read-only connections may create shared-memory companions. Open an isolated static copy
 * so preview never mutates a retained source directory. WAL/SHM/journal-bearing sources fail closed. */
export async function openRetentionSnapshot(
  path: string,
): Promise<{ database: DatabaseSync; dispose: () => Promise<void> }> {
  for (const suffix of ["-wal", "-shm", "-journal"])
    try {
      await lstat(`${path}${suffix}`);
      throw new Error("Recovery database has active or uncheckpointed companion files");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
    throw new Error("Recovery database is not an owned regular file");
  const temporary = await mkdtemp(join(tmpdir(), "dsh-sm-retention-readonly-"));
  let database: DatabaseSync | undefined;
  try {
    const target = join(temporary, "snapshot.sqlite");
    await copyFile(path, target);
    const after = await lstat(path, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error("Recovery database changed during snapshot capture");
    for (const suffix of ["-wal", "-shm", "-journal"])
      try {
        await lstat(`${path}${suffix}`);
        throw new Error("Recovery database started writing during snapshot capture");
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    database = new DatabaseSync(target, { readOnly: true });
    return {
      database,
      dispose: async () => {
        database!.close();
        await rm(temporary, { recursive: true, force: true });
      },
    };
  } catch (error) {
    database?.close();
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
