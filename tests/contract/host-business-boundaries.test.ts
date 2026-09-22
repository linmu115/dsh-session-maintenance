import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('keeps moved host behavior outside Engine and prevents an adapter dependency back to Engine', async () => {
  for (const name of ['launcher-install', 'launcher-instance-directory', 'standalone']) {
    const code = await readFile(`apps/engine/src/integrations/${name}.ts`, 'utf8');
    expect(code).toMatch(/^\/\/ Compatibility entry/);
    expect(code).not.toMatch(/node:fs|node:child_process|new |async function/);
  }
  for (const file of await readdir('packages/instance-integration-dsh/src')) {
    const code = await readFile(`packages/instance-integration-dsh/src/${file}`, 'utf8');
    expect(code, file).not.toMatch(/apps[\\/]engine|@linmu\/dsh-session-engine|from ['"]\.\.\//);
  }
  const composition = await readFile('apps/engine/src/composition-root.ts', 'utf8');
  expect(composition).not.toMatch(/namespace='thoughtdag'|reconcileSessionArchive|new SessionGraphStore/);
  const lifecycle = await readFile('apps/engine/src/session-lifecycle.ts', 'utf8');
  expect(lifecycle).not.toMatch(/thoughtdag|annotation|launcher|@deepseek-ai|node:fs/);
});
