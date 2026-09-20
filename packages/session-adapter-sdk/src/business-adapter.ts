import type { ExtensionDataAdapter } from '@linmu/dsh-session-contracts';

/** A declaration only: no database, process, or filesystem access is granted. */
export function defineExtensionDataAdapter<T extends ExtensionDataAdapter>(adapter: T): T {
  if (!/^[a-z][a-z0-9.-]{0,79}$/u.test(adapter.namespace) || !adapter.label?.trim())
    throw new TypeError('An extension adapter requires its namespace and display label');
  if (!Array.isArray(adapter.pluginVersions) || !adapter.pluginVersions.length || adapter.pluginVersions.some(value => typeof value !== 'string' || !value))
    throw new TypeError('Declare tested plugin versions');
  if (!Array.isArray(adapter.schemaVersions) || !adapter.schemaVersions.length || adapter.schemaVersions.some(value => !Number.isSafeInteger(value) || value < 1))
    throw new TypeError('Declare positive schema versions');
  if (adapter.capabilities?.context !== false || ['read', 'write', 'delete', 'restore', 'panel'].some(key => typeof adapter.capabilities[key as keyof typeof adapter.capabilities] !== 'boolean'))
    throw new TypeError('Declare adapter capabilities; context authorization belongs to Core');
  if (typeof adapter.validate !== 'function' || typeof adapter.summarize !== 'function')
    throw new TypeError('An extension adapter requires validate and summarize functions');
  return adapter;
}
