import { lstat, readdir, realpath, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { RetentionFile, RetentionResource, RetentionRoot } from "@linmu/dsh-session-contracts";

/** Hash sorted, JSON-compatible snapshots; no object bodies are needed. */
export function retentionDigest(value: unknown): string {
  const stable = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(stable)
      : item !== null && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, val]) => [key, stable(val)]),
          )
        : item;
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex")}`;
}

export function retentionRelative(value: string): string {
  if (
    !value ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((part) => !part || part === "." || part === ".." || part.includes(":"))
  ) {
    throw new Error("Unsafe retention relative path");
  }
  return value;
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function checkedAbsolute(path: string): Promise<string> {
  const absolute = resolve(path);
  let part = parse(absolute).root;
  for (const component of absolute.slice(part.length).split(sep).filter(Boolean)) {
    part = join(part, component);
    if ((await lstat(part)).isSymbolicLink())
      throw new Error("Symbolic links and junctions are not governed paths");
  }
  const physical = await realpath(absolute);
  if (relative(physical, absolute) !== "")
    throw new Error("Retention path resolves to another location");
  return physical;
}

export async function identifyRetentionRoot(
  id: string,
  path: string,
  purpose: RetentionRoot["purpose"],
): Promise<RetentionRoot> {
  if (!id.trim()) throw new TypeError("Root ID is required");
  const realPath = await checkedAbsolute(path);
  const info = await lstat(realPath, { bigint: true });
  if (!info.isDirectory()) throw new Error("Registered retention root must be a directory");
  return {
    id,
    path: resolve(path),
    realPath,
    identity: `${info.dev}:${info.ino}:${info.birthtimeNs}`,
    purpose,
  };
}

export async function checkedRetentionPath(root: RetentionRoot, child?: string): Promise<string> {
  const current = await identifyRetentionRoot(root.id, root.path, root.purpose);
  if (current.realPath !== root.realPath || current.identity !== root.identity)
    throw new Error("Registered root identity changed");
  if (child === undefined) return current.path;
  const target = resolve(root.path, retentionRelative(child));
  const rel = relative(root.realPath, target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))
    throw new Error("Retention target escapes registered root");
  await checkedAbsolute(target);
  return target;
}

/** Parent validation for a not-yet-created destination; caller rechecks before mutation. */
export async function checkedRetentionDestination(
  root: RetentionRoot,
  child: string,
): Promise<string> {
  retentionRelative(child);
  const components = child.split("/");
  components.pop();
  await checkedRetentionPath(root, components.length ? components.join("/") : undefined);
  return resolve(root.path, child);
}

export async function inventoryRetentionTree(
  root: RetentionRoot,
  child?: string,
): Promise<readonly RetentionFile[]> {
  const base = await checkedRetentionPath(root, child);
  const files: RetentionFile[] = [];
  const walk = async (absolute: string, rel: string): Promise<void> => {
    const info = await lstat(absolute, { bigint: true });
    if (info.isSymbolicLink()) throw new Error("Linked retention entry");
    if (!info.isDirectory() && !info.isFile()) throw new Error("Unsupported retention entry");
    if (info.isFile() && info.nlink !== 1n)
      throw new Error("Hard-linked retention files need explicit ownership proof");
    files.push({
      relativePath: rel,
      identity: `${info.dev}:${info.ino}:${info.birthtimeNs}:${info.isDirectory() ? "d" : "f"}`,
      bytes: info.isFile() ? Number(info.size) : 0,
      mtimeMs: Number(info.mtimeNs) / 1e6,
    });
    if (info.isDirectory())
      for (const name of (await readdir(absolute)).sort())
        await walk(join(absolute, name), rel ? `${rel}/${name}` : name);
  };
  await walk(base, "");
  await checkedRetentionPath(root, child);
  return files;
}

export async function readRetentionJson(root: RetentionRoot, child: string): Promise<unknown> {
  const path = await checkedRetentionPath(root, child);
  const info = await lstat(path);
  if (!info.isFile() || info.size > 32 * 1024 * 1024)
    throw new Error("Retention evidence is not a bounded JSON file");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function inventoryRetentionResource(
  root: RetentionRoot,
  resource: RetentionResource,
): Promise<readonly RetentionFile[]> {
  if (!resource.sqliteBundle) return inventoryRetentionTree(root, resource.relativePath);
  const [main, manifest] = resource.sqliteBundle;
  if (!main || manifest !== `${main}.manifest.json` || resource.sqliteBundle.length !== 2)
    throw new Error("Unsupported SQLite bundle membership");
  await assertStaticSqliteCompanions(root, main, resource.sqliteBundle);
  const files: RetentionFile[] = [];
  for (const member of resource.sqliteBundle) {
    const inventory = await inventoryRetentionTree(root, member),
      file = inventory[0];
    if (!file || inventory.length !== 1 || !file.identity.endsWith(":f"))
      throw new Error("SQLite bundle member is not a regular file");
    files.push({ ...file, relativePath: basename(member) });
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/** WAL/SHM and rollback journals are never moved based on a static snapshot assumption. */
export async function assertStaticSqliteCompanions(
  root: RetentionRoot,
  main: string,
  allowed: readonly string[],
): Promise<void> {
  const parent = dirname(main).replaceAll("\\", "/"),
    dir = await checkedRetentionPath(root, parent === "." ? undefined : parent);
  const name = basename(main),
    allow = new Set(allowed.map((entry) => basename(entry)));
  for (const entry of await readdir(dir))
    if (entry.startsWith(`${name}-`) || entry.startsWith(`${name}.`)) {
      if (!allow.has(entry))
        throw new Error("SQLite snapshot has active or unknown companion files");
    }
}
