import type {
  AdapterContractRef,
  BackupManifest,
  Checkpoint,
  CompatibilityIssue,
  CompatibilityStatus,
  InstanceStatus,
  NormalizedSession,
  ObservedHead,
  PlatformBinding,
  SessionSummary,
  SessionVersionManifest,
  TransactionRecord,
  TransactionStep,
  TransactionStatus,
} from "./model.js";

export interface SessionDetail {
  readonly summary: SessionSummary;
  readonly bindings: readonly PlatformBinding[];
  readonly heads: readonly ObservedHead[];
}

export interface VersionContent {
  readonly manifest: SessionVersionManifest;
  readonly session: NormalizedSession;
}

export interface TransactionQuery {
  readonly cursor?: string;
  readonly limit?: number;
  readonly status?: TransactionStatus;
}

export interface TransactionSummary {
  readonly id: string;
  readonly planId: string;
  readonly platform: "dsh";
  readonly instanceId: string;
  readonly status: TransactionStatus;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TransactionDetail {
  readonly transaction: TransactionRecord;
  readonly steps: readonly TransactionStep[];
  readonly backup?: BackupManifest;
}

export interface CheckpointListResponse {
  readonly checkpoints: readonly Checkpoint[];
}

export interface AdapterDiagnostic {
  readonly instance: InstanceStatus;
  readonly readContract: AdapterContractRef;
  readonly writeContract?: AdapterContractRef;
  readonly writeCapabilities: readonly string[];
  readonly writeStatus: CompatibilityStatus | "unavailable";
  readonly issues: readonly CompatibilityIssue[];
}

export interface MaintenanceSettings {
  readonly codexInstanceId: string | null;
  readonly dshInstanceId: string | null;
  readonly workspaceMappingId: string | null;
  readonly syncSingleSidedTitle: boolean;
  readonly syncArchive: boolean;
  readonly scanScope: "current" | "registered";
  readonly backupRetention: number;
  readonly allowBatchSafeApply: boolean;
}

export type MaintenanceSettingsPatch = Partial<MaintenanceSettings>;

export interface DashboardOverview {
  readonly sessions: number;
  readonly conflicts: number;
  readonly unmapped: number;
  readonly unresolvedTransactions: number;
  readonly instances: readonly InstanceStatus[];
}
