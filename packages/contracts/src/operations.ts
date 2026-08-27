import type {
  AdapterContractRef,
  BackupManifest,
  Checkpoint,
  CompatibilityIssue,
  CompatibilityStatus,
  InstanceStatus,
  NormalizedSession,
  NativeMirrorRecord,
  ObservedHead,
  PlatformBinding,
  PlatformKind,
  SessionSummary,
  SessionVersionManifest,
  TransactionRecord,
  TransactionStep,
  TransactionStatus,
} from "./model.js";
import type { SyncPlan } from "./plans.js";

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
  readonly platform: PlatformKind;
  readonly instanceId: string;
  readonly status: TransactionStatus;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlanQuery {
  readonly cursor?: string;
  readonly limit?: number;
  readonly risk?: SyncPlan["risk"];
}

export interface PlanSummary {
  readonly id: string;
  readonly logicalSessionId: string;
  readonly createdAt: string;
  readonly risk: SyncPlan["risk"];
  readonly operationCount: number;
  readonly confirmationCount: number;
}

export interface TransactionDetail {
  readonly transaction: TransactionRecord;
  readonly steps: readonly TransactionStep[];
  readonly backup?: BackupManifest;
  readonly recovery: TransactionRecoveryDecision;
}

export interface TransactionRecoveryDecision {
  readonly action: "recover-interrupted" | "restore-completed" | "none";
  readonly allowed: boolean;
  readonly confirmationRequired: boolean;
  readonly reason: string;
  readonly backupHash?: string;
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

export interface DashboardLaunchInfo {
  readonly url: string;
  readonly expiresAt: string;
}

export interface DashboardUiSession {
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly initialLogicalSessionId?: string;
}

export interface PlatformSessionResolution {
  readonly logicalSessionId: string;
  readonly bindingId: string;
  readonly title: string;
  readonly status: SessionSummary["status"];
}

export type NativeMirrorAction =
  | "enable"
  | "pause"
  | "resume"
  | "keep-branches"
  | "choose-canonical"
  | "unlink"
  | "reset-target"
  | "delete-target";

export interface NativeMirrorActionRequest {
  readonly action: NativeMirrorAction;
  readonly platform?: "codex" | "dsh";
  readonly reason?: string;
  readonly confirmationToken?: string;
}

export interface NativeMirrorActionPreview {
  readonly logicalSessionId: string;
  readonly action: NativeMirrorAction;
  readonly allowed: boolean;
  readonly confirmationRequired: boolean;
  readonly operationHash: string;
  readonly message: string;
  readonly mirror?: NativeMirrorRecord;
}
