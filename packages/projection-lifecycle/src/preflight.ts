import type { StatusStage } from "@linmu/dsh-session-contracts";

export interface ProjectionRuntimeCapabilityEvidence {
  readonly runtimeBrokerPrepareCloseApi: boolean;
  readonly runtimeClientRunIdHandoff: boolean;
  readonly temporaryPersistenceRoot: boolean;
  readonly runtimeAttachAcknowledgement: boolean;
  readonly durableAppendForwarding: boolean;
  readonly projectRootCwdMapping: boolean;
  readonly maintenanceWorkspaceAuthority: boolean;
}

export type ProjectionRuntimeBlocker =
  | "RUNTIME_BROKER_API_MISSING"
  | "RUNTIME_CLIENT_RUN_ID_HANDOFF_MISSING"
  | "TEMP_PERSISTENCE_ROOT_MISSING"
  | "RUNTIME_ATTACH_ACK_MISSING"
  | "DURABLE_APPEND_FORWARDING_MISSING"
  | "PROJECT_ROOT_CWD_MAPPING_MISSING"
  | "MAINTENANCE_WORKSPACE_AUTHORITY_MISSING";

export interface ProjectionRuntimeCheckpoint {
  readonly checkpoint: "P1" | "P2" | "P3" | "APPEND" | "CLOSE" | "GROUPING";
  readonly stage: StatusStage;
  readonly ready: boolean;
  readonly blockers: readonly ProjectionRuntimeBlocker[];
  readonly diagnosticDetailRef: string;
}

export interface ProjectionRuntimePreflight {
  readonly schemaVersion: 1;
  readonly canOpenRun: boolean;
  readonly checkpoints: readonly ProjectionRuntimeCheckpoint[];
  readonly blockers: readonly ProjectionRuntimeBlocker[];
}

function checkpoint(
  name: ProjectionRuntimeCheckpoint["checkpoint"],
  stage: StatusStage,
  blockers: readonly ProjectionRuntimeBlocker[],
): ProjectionRuntimeCheckpoint {
  return {
    checkpoint: name,
    stage,
    ready: blockers.length === 0,
    blockers,
    diagnosticDetailRef: `diag:projection-preflight:${name.toLowerCase()}:${blockers.join(",") || "ready"}`,
  };
}

export function projectionRuntimePreflight(
  evidence: ProjectionRuntimeCapabilityEvidence,
): ProjectionRuntimePreflight {
  const checkpoints = [
    checkpoint("P1", "run.lease", [
      ...(evidence.runtimeBrokerPrepareCloseApi ? [] : ["RUNTIME_BROKER_API_MISSING" as const]),
      ...(evidence.runtimeClientRunIdHandoff ? [] : ["RUNTIME_CLIENT_RUN_ID_HANDOFF_MISSING" as const]),
    ]),
    checkpoint("P2", "projection.materialize", [
      ...(evidence.projectRootCwdMapping ? [] : ["PROJECT_ROOT_CWD_MAPPING_MISSING" as const]),
    ]),
    checkpoint("P3", "runtime.persistence.attach", [
      ...(evidence.temporaryPersistenceRoot ? [] : ["TEMP_PERSISTENCE_ROOT_MISSING" as const]),
      ...(evidence.runtimeAttachAcknowledgement ? [] : ["RUNTIME_ATTACH_ACK_MISSING" as const]),
    ]),
    checkpoint("APPEND", "session.append.commit", [
      ...(evidence.durableAppendForwarding ? [] : ["DURABLE_APPEND_FORWARDING_MISSING" as const]),
    ]),
    checkpoint("CLOSE", "run.shutdown-recovery", [
      ...(evidence.runtimeBrokerPrepareCloseApi ? [] : ["RUNTIME_BROKER_API_MISSING" as const]),
      ...(evidence.temporaryPersistenceRoot ? [] : ["TEMP_PERSISTENCE_ROOT_MISSING" as const]),
    ]),
    checkpoint("GROUPING", "projection.cross-version.verify", [
      ...(evidence.projectRootCwdMapping ? [] : ["PROJECT_ROOT_CWD_MAPPING_MISSING" as const]),
      ...(evidence.maintenanceWorkspaceAuthority ? [] : ["MAINTENANCE_WORKSPACE_AUTHORITY_MISSING" as const]),
    ]),
  ];
  const blockers = [...new Set(checkpoints.flatMap((item) => item.blockers))];
  return { schemaVersion: 1, canOpenRun: blockers.length === 0, checkpoints, blockers };
}

/** @deprecated Use the client-neutral Runtime Broker terminology. */
export const projectionLaunchPreflight = projectionRuntimePreflight;
