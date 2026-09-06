import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

const bindingSchema = z.strictObject({
  targetId: z.string(), kind: z.enum(["dsh", "codex"]), instanceId: z.string(), profileId: z.string().nullable(),
  launcherDataRoot: z.string().nullable(), runtimeVersion: z.string(), adapterId: z.string().nullable(),
  fingerprint: z.string(), checkedAt: z.iso.datetime(),
});
const bindingFileSchema = z.strictObject({ schemaVersion: z.literal(1), bindings: z.array(bindingSchema) });
export type InstanceIntegrationBinding = z.infer<typeof bindingSchema>;

export class IntegrationError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}

export function integrationBindingsPath(stateRoot: string): string { return join(stateRoot, "instance-integrations.json"); }

export async function readJsonIfPresent(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Caller owns the Engine write scope. Provider processes only read this atomic snapshot. */
export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function readIntegrationBindings(stateRoot: string): Promise<InstanceIntegrationBinding[]> {
  const value = await readJsonIfPresent(integrationBindingsPath(stateRoot));
  if (value === undefined) return [];
  const parsed = bindingFileSchema.safeParse(value);
  if (!parsed.success || new Set(parsed.data?.bindings.map(item => item.targetId)).size !== parsed.data?.bindings.length) {
    throw new IntegrationError("INTEGRATION_STATE_INVALID", "接入配置损坏，请从已验证备份恢复；本次不会启动接入。", 503);
  }
  return parsed.data.bindings;
}

export async function saveIntegrationBindings(stateRoot: string, bindings: InstanceIntegrationBinding[]): Promise<void> {
  await writeJsonAtomically(integrationBindingsPath(stateRoot), bindingFileSchema.parse({ schemaVersion: 1, bindings }));
}
