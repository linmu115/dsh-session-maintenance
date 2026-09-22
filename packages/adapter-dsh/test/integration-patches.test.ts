import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { inspectDshIntegrationOverrides } from '@linmu/dsh-adapter-dsh';
// The rule and its constants live in the shared contracts package, so both the adapter and the
// plugin can use the same one.
import { MAINTENANCE_PLUGIN_CONFIG_KEYS, MAINTENANCE_PLUGIN_ROW_ID, maintenancePluginConfigIssue } from '@linmu/dsh-session-contracts';
import { maintenanceIntegrationBundleReady } from '../src/integration-patches.js';

/**
 * The `session-maintenance` row carries the machine's declaration, so a config on it must be
 * verified rather than refused — while every other infrastructure id keeps being reported as a
 * component replacement. These tests pin both halves, including the ones that must NOT change.
 */
const declaredConfig = { connectionId: 'primary', dshInstanceId: 'i-27c4d5a7-bdb5-4b8a-8d95-6267f47499c5', profileId: 'web-i27c4' };

it('accepts the identity declaration this machine actually needs', () => {
  // Exactly the row from `profiles/web/cordis.patch.yml` on the real machine.
  expect(inspectDshIntegrationOverrides([[{ id: 'session-maintenance', config: { ...declaredConfig } }]])).toEqual([]);
});

it('rejects an unknown field on the declaration and names it', () => {
  const issues = inspectDshIntegrationOverrides([[{ id: 'session-maintenance', config: { ...declaredConfig, unknownField: 1 } }]]);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toContain('unknownField');
  // A loader-level key that does not belong to the plugin config at all is named too.
  expect(inspectDshIntegrationOverrides([[{ id: 'session-maintenance', group: true, config: { ...declaredConfig } }]]).join(' '))
    .toContain('group');
  // A value the plugin's own schema refuses is refused here as well.
  expect(inspectDshIntegrationOverrides([[{ id: 'session-maintenance', config: { ...declaredConfig, maintenanceEndpoint: 'http://10.0.0.5:1' } }]])[0])
    .toContain('loopback');
  expect(inspectDshIntegrationOverrides([[{ id: 'session-maintenance', config: { ...declaredConfig, dshInstanceId: '' } }]])[0])
    .toContain('dshInstanceId');
  expect(inspectDshIntegrationOverrides([[{ id: 'session-maintenance', config: { ...declaredConfig, adapterSelection: 'pinned' } }]])[0])
    .toContain('pinnedAdapterId');
});

it('still reports a disabled plugin row and a modified one without config', () => {
  expect(inspectDshIntegrationOverrides([[{ id: 'session-maintenance', disabled: true }]])[0]).toContain('禁用');
  expect(inspectDshIntegrationOverrides([[{ id: 'session-maintenance', name: 'dsh-session-maintenance' }]])).toEqual([]);
});

it('still reports a config on any other infrastructure id, and any replacement', () => {
  const other = inspectDshIntegrationOverrides([[{ id: 'session-persistence', config: { root: '/tmp' } }]]);
  expect(other).toHaveLength(1);
  expect(other[0]).toContain('需要单独验证');
  // The component-replacement check is unchanged: it fires on an infrastructure id or package name
  // inserted by the user, including this plugin's own package.
  expect(inspectDshIntegrationOverrides([[{ insert: [{ id: 'session', name: '@deepseek-ai/dsh-session' }] }]])
    .join(' ')).toContain('替换了会话或 Web 基础组件');
  // The plugin's own insert row is recognised as the integration bundle, not as a replacement.
  expect(maintenanceIntegrationBundleReady([{ insert: [{ id: MAINTENANCE_PLUGIN_ROW_ID, name: 'dsh-session-maintenance' }] }])).toBe(true);
  // ...but a user-supplied insert still reports the package replacement, as before.
  expect(inspectDshIntegrationOverrides([[{ insert: [{ id: 'session-maintenance', name: 'dsh-session-maintenance' }] }]])
    .join(' ')).toContain('替换了会话或 Web 基础组件');
});

it('keeps the accepted field set identical to the plugin schema (drift guard)', () => {
  // The rule is shared through contracts; the plugin still owns its schema, so a change on either
  // side without the other must fail here rather than silently accepting a different config.
  const source = readFileSync(new URL('../../../plugins/dsh-session-maintenance/src/index.ts', import.meta.url), 'utf8');
  const schema = /export const Config: s = s\.object\(\{([\s\S]*?)\n\}\);/u.exec(source);
  expect(schema, 'the plugin Config schema was not found').not.toBeNull();
  const keys = [...schema![1]!.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gmu)].map(match => match[1]!).sort();
  expect(keys).toEqual([...MAINTENANCE_PLUGIN_CONFIG_KEYS].sort());
  expect(source).toContain(`export const name = "dsh-session-maintenance"`);
  // The row id is the plugin's own id; a rename must be deliberate on both sides.
  expect(MAINTENANCE_PLUGIN_ROW_ID).toBe('session-maintenance');
  expect(maintenancePluginConfigIssue(undefined, ['id', 'config'])).toBeUndefined();
});
