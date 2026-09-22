/** Core-owned runtime records; host adapters do not open the Engine database to inspect them. */
export type EndpointRecoveryQuery = (stateRoot: string, endpointId: string, profileId: string) => Promise<readonly {
  readonly id: string; readonly state: string; readonly startedAt: string;
}[]>;

export interface SessionLifecycleState {
  readonly logicalSessionId: string;
  readonly archivedAt: string | null;
  readonly deleted: boolean;
}

/** Callbacks execute in the canonical transaction. Throwing rolls back the mutation. */
export interface SessionLifecycleAdapter {
  readonly id: string;
  initialize?(sessions: readonly SessionLifecycleState[]): void;
  sessionChanged(state: SessionLifecycleState): void;
}
