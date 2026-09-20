import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { assertRegisteredStartup } from '../src/registered-startup.js';
it('allows independent instances but refuses direct startup for a registered identity, even without a connection file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'SYNTHETIC-registered-startup-'));
  const config = { connectionId: 'primary', dshInstanceId: 'example', profileId: 'web' };
  try {
    const path = join(root, 'connection.json');
    await assertRegisteredStartup(config, path, false);
    await writeFile(join(root, 'maintenance-required.json'), JSON.stringify({ schemaVersion: 1, required: [{ instanceId: 'example', profileId: 'web' }] }));
    await expect(assertRegisteredStartup(config, path, false)).rejects.toThrow('请先启动');
    await assertRegisteredStartup({ ...config, dshInstanceId: 'independent' }, path, false);
    await assertRegisteredStartup(config, path, true);
    await writeFile(join(root, 'maintenance-required.json'), 'invalid');
    await expect(assertRegisteredStartup(config, path, false)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
