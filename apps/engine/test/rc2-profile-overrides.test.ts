import { expect, it } from 'vitest';
import { inspectRc2ProfileOverrides } from '../src/integrations/rc2-profile-overrides.js';
const scope = { runtimeVersion: '0.1.5-rc.2', instanceId: 'instance-new', profileId: 'web' };
const maintenance = { id: 'session-maintenance', config: { connectionId: 'primary', dshInstanceId: scope.instanceId, profileId: scope.profileId, sessionSource: 'maintenance' } };
it('admits the actual scoped maintenance and loopback Web settings', () => {
  expect(inspectRc2ProfileOverrides([[maintenance, { id: 'webserver', config: { host: '127.0.0.1', port: 0, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 } }]], scope)).toEqual([]);
});
it.each([
  { ...maintenance, disabled: true },
  { ...maintenance, name: 'another-implementation' },
  { ...maintenance, config: { ...maintenance.config, dshInstanceId: 'another-instance' } },
  { ...maintenance, config: { ...maintenance.config, sessionSource: 'native' } },
  { id: 'webserver', config: { host: '0.0.0.0', port: 0 } },
  { id: 'session-persistence-jsonl', config: { root: 'another-space' } },
  { insert: [{ id: 'session-maintenance', name: 'dsh-session-maintenance' }] },
])('still refuses scope, service and storage changes: %j', patch => {
  expect(inspectRc2ProfileOverrides([[patch]], scope).length).toBeGreaterThan(0);
});
it('retains the previous contract for old adapters', () => {
  expect(inspectRc2ProfileOverrides([[maintenance]], { ...scope, runtimeVersion: '0.1.2-rc.1' }).length).toBeGreaterThan(0);
});
