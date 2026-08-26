import type {
  GcPolicy,
  GcReport,
  LogicalSession,
  MatchCandidate,
  NewVersion,
  ObservationRecord,
  ObservedHead,
  Page,
  PlatformBinding,
  PlatformSessionKey,
  RepositoryCounts,
  RepositoryWriteResult,
  SessionQuery,
  SessionSummary,
  SessionVersionManifest,
  VersionGraphData,
  VersionGraphPage,
} from "./model.js";
import type { SyncPlan } from "./plans.js";

export interface SessionRepository {
  createLogicalSession(input: LogicalSession): Promise<boolean>;
  findBinding(key: PlatformSessionKey): Promise<PlatformBinding | undefined>;
  bindPlatformSession(input: PlatformBinding): Promise<boolean>;
  getObservedHead(bindingId: string): Promise<ObservedHead | undefined>;
  putVersion(input: NewVersion): Promise<SessionVersionManifest>;
  recordObservation(input: ObservedHead): Promise<void>;
  recordObservedVersion(input: ObservationRecord): Promise<RepositoryWriteResult>;
  upsertMatchCandidate(input: MatchCandidate): Promise<boolean>;
  listMatchCandidates(logicalSessionId: string): Promise<readonly MatchCandidate[]>;
  listBindings(logicalSessionId: string): Promise<readonly PlatformBinding[]>;
  counts(): Promise<RepositoryCounts>;
  getGraph(logicalSessionId: string): Promise<VersionGraphData>;
  listSessions(query: SessionQuery): Promise<Page<SessionSummary>>;
  getGraphPage(logicalSessionId: string, cursor?: string): Promise<VersionGraphPage>;
  listReachableObjectIds(): Promise<readonly string[]>;
  savePlan(plan: SyncPlan): Promise<void>;
  getPlan(id: string): Promise<SyncPlan | undefined>;
}

export interface ContentObjectStore {
  put(bytes: Uint8Array): Promise<string>;
  get(hash: string): Promise<Uint8Array>;
  collect(policy: GcPolicy): Promise<GcReport>;
}
