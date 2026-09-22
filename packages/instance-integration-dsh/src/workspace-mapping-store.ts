import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
const mappingsSchema = z.array(z.strictObject({ workspaceId: z.string(), folder: z.string(), path: z.string(), owned: z.boolean() }));
export type StoredWorkspaceMapping = z.infer<typeof mappingsSchema>[number];
const pathFor = (root: string, endpointId: string) => join(root, 'adapter-workspaces', `${createHash('sha256').update(endpointId).digest('hex')}.json`);
export async function readWorkspaceMappings(root: string, endpointId: string): Promise<readonly StoredWorkspaceMapping[]> {
  const text = await readFile(pathFor(root, endpointId), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (text === undefined) return [];
  const record = z.strictObject({ schemaVersion: z.literal(1), endpointId: z.literal(endpointId), mappings: mappingsSchema }).parse(JSON.parse(text));
  return record.mappings;
}
export async function saveWorkspaceMappings(root: string, endpointId: string, mappings: readonly StoredWorkspaceMapping[]): Promise<void> {
  const all = new Map((await readWorkspaceMappings(root, endpointId)).map(item => [item.workspaceId, item]));
  for (const item of mappings) all.set(item.workspaceId, item);
  const path = pathFor(root, endpointId), staged = `${path}.${process.pid}.staged`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(staged, JSON.stringify({ schemaVersion: 1, endpointId, mappings: [...all.values()] }) + '\n');
  await rename(staged, path);
}
