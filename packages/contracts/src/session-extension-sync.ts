import type { JsonValue } from './model.js';

/** Optional replica transport. The host owns local durability and conflict decisions. */
export interface SessionExtensionReplicaObject {
  sessionId: string; namespace: string; objectId: string; revision: number;
  deleted: boolean; content: JsonValue;
}
export interface SessionExtensionSync {
  readonly protocolVersion: 1;
  readonly namespaces: readonly string[];
  read(namespace: string, sessionId?: string): Promise<readonly SessionExtensionReplicaObject[]>;
  commit(value: SessionExtensionReplicaObject): Promise<void>;
}
