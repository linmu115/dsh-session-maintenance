import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceFolderAdapter } from '@linmu/dsh-session-contracts';
import { readWorkspaceMappings } from './workspace-mapping-store.js';
import { nativeProjectDirectory } from './native-session-overwrite.js';

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
