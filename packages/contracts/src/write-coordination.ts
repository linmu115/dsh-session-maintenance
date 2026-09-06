/** A local owner generation, supplemented by each caller's database/reference fingerprint. */
export interface MaintenanceWriteEvidence {
  readonly schemaVersion: 1;
  readonly ownerId: string;
  readonly stateRoot: string;
  readonly generation: number;
  readonly activeScope: string | null;
}

export interface MaintenanceWriteScope {
  run<T>(scope: string, operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T>;
  runSync<T>(scope: string, operation: () => T): T;
  captureEvidence(): MaintenanceWriteEvidence;
  assertEvidence(evidence: MaintenanceWriteEvidence): void;
  assertInScope(): void;
}
