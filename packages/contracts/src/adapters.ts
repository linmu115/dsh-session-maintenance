import type {
  AdapterProbe,
  ExpectedPlatformState,
  NormalizedSession,
  ObservationHint,
  Page,
  PlatformSessionKey,
  PlatformSessionSummary,
  RegisteredInstance,
  ScanCursor,
  SessionDiff,
  SessionQuery,
  SessionSummary,
  StableObservation,
  UnstableRead,
  VerificationResult,
  VersionGraphPage,
  InstanceStatus,
  DiscoveryResult,
  EngineStatus,
} from "./model.js";
import type { DiffRequest, PlanRequest, ScanRequest, SyncPlan } from "./plans.js";

export interface SessionReadAdapter {
  readonly platform: "codex" | "dsh";
  probe(instance: RegisteredInstance): Promise<AdapterProbe>;
  list(
    instance: RegisteredInstance,
    cursor?: ScanCursor,
  ): AsyncIterable<PlatformSessionSummary>;
  observe(
    instance: RegisteredInstance,
    key: PlatformSessionKey,
    hint?: ObservationHint,
  ): Promise<StableObservation | UnstableRead>;
  normalize(observation: StableObservation): Promise<NormalizedSession>;
  verify(
    instance: RegisteredInstance,
    key: PlatformSessionKey,
    expected: ExpectedPlatformState,
  ): Promise<VerificationResult>;
}

export interface ReadOnlyEngine {
  listInstances(): Promise<readonly InstanceStatus[]>;
  listSessions(query: SessionQuery): Promise<Page<SessionSummary>>;
  getGraph(id: string, cursor?: string): Promise<VersionGraphPage>;
  scan(request: ScanRequest): Promise<DiscoveryResult>;
  diff(request: DiffRequest): Promise<SessionDiff>;
  createPlan(request: PlanRequest): Promise<SyncPlan>;
  getPlan(id: string): Promise<SyncPlan | undefined>;
  status(): Promise<EngineStatus>;
}
