import { readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { WorkspaceFolderAdapter } from '@linmu/dsh-session-contracts';
import { readWorkspaceMappings, saveWorkspaceMappings } from './workspace-mapping-store.js';
import { nativeProjectDirectory } from './native-session-overwrite.js';
import { readRegisteredWorkspacePaths } from './instance-write-back.js';
import { IntegrationError } from '@linmu/dsh-session-contracts';

/** Preserve even an empty joined workspace's native path for subsequent session discovery. */
export async function rememberJoinedWorkspace(input: { stateRoot: string; endpointId: string; homeRoot: string; workspaceId: string; path: string }): Promise<void> {
  const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
  const paths = await readRegisteredWorkspacePaths(input.homeRoot);
  if (![...paths.values()].some(path => same(path, input.path)))
    throw new IntegrationError('WORKSPACE_JOIN_PATH_UNREGISTERED', '该目录尚未登记为宿主工作区，不能建立映射。');
  const mappings = await readWorkspaceMappings(input.stateRoot, input.endpointId);
  if (mappings.some(item => item.workspaceId !== input.workspaceId && same(item.path, input.path)
    || item.workspaceId === input.workspaceId && !same(item.path, input.path)))
    throw new IntegrationError('SYNC_WORKSPACE_PATH_CONFLICT', '工作区目录已有不同映射，未覆盖原记录。');
  await saveWorkspaceMappings(input.stateRoot, input.endpointId, [{ workspaceId: input.workspaceId,
    path: input.path, folder: basename(input.path), owned: true }]);
}

export function createWorkspaceFolderAdapter(options: {
  readonly homeFor: (endpointId: string) => Promise<string | undefined>;
  readonly workspaceRoot: string;
  readonly stateRoot: string;
}): WorkspaceFolderAdapter {
  return { list: async ({ endpointId, buckets }) => {
    const home = await options.homeFor(endpointId);
    if (home === undefined) return [];
    const selected = new Set(buckets.map(item => item.workspaceId));
    const mapped = (await readWorkspaceMappings(options.stateRoot, endpointId)).filter(item => selected.has(item.workspaceId));
    const folders = [];
    for (const folder of mapped) {
      const directory = join(home, 'sessions', nativeProjectDirectory(folder.path));
      const sessions: string[] = [];
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => {
        if (error.code === 'ENOENT') return []; throw error;
      })) {
        if (!entry.isDirectory()) continue;
        for (const artifact of await readdir(join(directory, entry.name), { withFileTypes: true })) {
          if (!artifact.isFile() || !/^session\.v3\.jsonl(?:\.zstd)?$/u.test(artifact.name)) continue;
          if ((await stat(join(directory, entry.name, artifact.name))).size > 0) { sessions.push(entry.name); break; }
        }
      }
      folders.push({ name: folder.folder, path: folder.path, sessions });
    }
    return folders;
  } };
}
