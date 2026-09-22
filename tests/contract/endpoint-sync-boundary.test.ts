import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('keeps synchronization decisions independent of host SDKs, files and plugin vocabularies', async () => {
  const files = ['apps/engine/src/endpoint-sync.ts', 'apps/engine/src/endpoint-session-commands.ts',
    'apps/engine/src/instance-workspace-service.ts', 'apps/engine/src/instance-workspace-runtime.ts',
    'packages/canonical-session-engine/src/endpoint-reconcile.ts'];
  for (const file of files) {
    const code = await readFile(resolve(file), 'utf8');
    expect(code, file).not.toMatch(/from\s+['"](?:@deepseek-ai\/|@linmu\/dsh-(?:instance-integration|session-adapter|session-extension)|node:fs)/);
    expect(code, file).not.toMatch(/storages[\\/]|session\.v3|archivedSessionIds|context\/operation|taskkill|in\.dsh-plug/);
  }
});
