import { expect, it } from 'vitest';
import { inspectRc2ProfileOverrides } from '../src/integrations/rc2-profile-overrides.js';
const scope = { runtimeVersion: '0.1.5-rc.2', instanceId: 'instance-new', profileId: 'web' };
const maintenance = { id: 'session-maintenance', config: { connectionId: 'primary', dshInstanceId: scope.instanceId, profileId: scope.profileId, sessionSource: 'maintenance' } };
const upstream = { namespace: 'annotation-upstream', pluginVersion: '0.3.12-rc2.1', writerId: 'dsh-annotation-core' };
it('admits the actual scoped maintenance and loopback Web settings', () => {
  expect(inspectRc2ProfileOverrides([[maintenance, { id: 'webserver', config: { host: '127.0.0.1', port: 0, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 } }]], scope)).toEqual([]);
});
it.each([[], [upstream], [upstream, { namespace: 'obsidian.references', pluginVersion: '1', writerId: 'obsidian' }]].map(plugins => ({ plugins })))('admits configured extension plugins within the existing scope: %j', ({ plugins }) => {
  const patch = { ...maintenance, config: { ...maintenance.config, extensionPlugins: plugins } };
  expect(inspectRc2ProfileOverrides([[patch]], scope)).toEqual([]);
  expect(inspectRc2ProfileOverrides([[patch, { id: 'session-persistence-jsonl', config: { root: 'another-space' } }]], scope).length).toBeGreaterThan(0);
});
it.each([
  [{ ...upstream, namespace: '../session-persistence' }],
  [{ ...upstream, writerId: '' }],
  [{ ...upstream, pluginVersion: '' }],
  [{ ...upstream, instanceId: 'another-instance' }],
  { plugins: [upstream] },
].map(plugins => ({ plugins })))('refuses malformed extension configuration: %j', ({ plugins }) => {
  expect(inspectRc2ProfileOverrides([[{ ...maintenance, config: { ...maintenance.config, extensionPlugins: plugins } }]], scope).length).toBeGreaterThan(0);
});
it.each([
  { ...maintenance, disabled: true },
  { ...maintenance, name: 'another-implementation' },
  { ...maintenance, config: { ...maintenance.config, dshInstanceId: 'another-instance' } },
  { ...maintenance, config: { ...maintenance.config, profileId: 'another-profile', extensionPlugins: [upstream] } },
  { ...maintenance, config: { ...maintenance.config, extensionPlugins: [upstream], root: 'another-space' } },
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
