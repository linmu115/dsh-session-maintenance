import { expect, it } from 'vitest';
import { createEngineFixture, hashTree } from './helpers.js';

it('starts and closes a DSH projection with mirror disabled and leaves Codex untouched', async () => {
  const f = await createEngineFixture('mirror-independent-startup', { enableCodexMirror: false });
  try {
    const before = await hashTree(f.codexHome);
    expect(f.engine.codexMirror!.status().active).toEqual({ mirror: false, bidirectional: false, background: false });
    const request = { schemaVersion: 1 as const, client: { kind: 'launcher' as const, id: 'independent-launch' }, runtimeClientId: 'independent-runtime',
      instanceId: 'synthetic-independent', profileId: 'web', dshVersion: '0.1.2-rc.1', maintenanceEndpoint: 'http://127.0.0.1:41781',
      branchId: 'main' as never, pinnedAdapterId: 'dsh-rc1' as never, projectSelection: { kind: 'all' as const },
      environment: { packageVersions: { '@deepseek-ai/dsh-session': '0.1.2-rc.1', '@deepseek-ai/dsh-session-persistence': '0.1.2-rc.1' }, runtimeCapabilities: ['sessionPersistence', 'session/event', 'session/flush'] } };
    const run = await f.engine.prepareProjectionRuntimeRun(request);
    expect(await f.engine.projectionRunRepository.listProjectionSessions(run.runId)).toHaveLength(0);
    await f.engine.closeProjectionRuntimeRun({ schemaVersion: 1, clientId: request.client.id, runId: run.runId, reason: 'recovery' });
    expect(await hashTree(f.codexHome)).toBe(before);
    await expect(f.engine.importCodex({ operationId: 'disabled', instanceIds: ['codex-fixture' as never], mode: 'content' })).rejects.toThrow('未启用');
  } finally { await f.cleanupAll(); }
});
