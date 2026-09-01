export interface CodexReadStatusEvent {
  readonly stage: "catalog.snapshot" | "rollout.stability";
  readonly state: "succeeded" | "retry";
  readonly instanceId: string;
  readonly sessionId: string | null;
  readonly consistency: "sqlite-read-transaction" | "double-stat";
  readonly detail: string;
}
