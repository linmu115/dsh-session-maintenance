import {
  type JsonValue,
  type WriteCapability,
  type WriteProbe,
} from "@linmu/dsh-session-contracts";
import { sha256Canonical } from "@linmu/dsh-session-domain";

export interface DshWriteSurfaceObservation {
  readonly platformVersion: string;
  readonly sessionFormatVersion: number;
  readonly packages: Readonly<Record<string, { readonly version: string; readonly integrity: string }>>;
  readonly sessionPersistence: readonly string[];
  readonly workspaceRegistry: readonly string[];
  readonly sessionTitle: readonly string[];
}

export type DisabledDshWriteCapabilities = Readonly<Record<
  Exclude<WriteCapability, "verify">,
  string
>>;

export interface DshWriteContractAssessment {
  readonly probe: WriteProbe;
  readonly disabledCapabilities: DisabledDshWriteCapabilities;
}

export const DSH_RC2_WRITE_SURFACE = {
  platformVersion: "0.1.1-rc.2",
  sessionFormatVersion: 0,
  packages: {
    "@deepseek-ai/dsh-session-persistence": {
      version: "0.1.1-rc.2",
      integrity:
        "sha512-dxdYxRfmK5jWtiFFabqRNb/jGGjkXyF2djI7O8IIKmDVjhQiv170zpvhbAhRUuqClEdseCtbQpLBrRm2blzt3g==",
    },
    "@deepseek-ai/dsh-workspace": {
      version: "0.1.1-rc.2",
      integrity:
        "sha512-jBUob4H5TZAiExq9YNVCglKAFmAKMtd1UbyqFfnZZ1Owm+3c3NbAXY947MHiD6NwCwFEW1y7FjrFj66UQvG90A==",
    },
  },
  sessionPersistence: [
    "append",
    "create",
    "inspect",
    "list",
    "listSnapshots",
    "load",
    "locate",
    "prepare",
    "readFrom",
    "readRaw",
  ],
  workspaceRegistry: [
    "archiveSession",
    "create",
    "delete",
    "get",
    "insertBefore",
    "list",
    "resolveByPath",
  ],
  sessionTitle: ["get", "refresh", "register", "rename"],
} as const satisfies DshWriteSurfaceObservation;

function fingerprint(surface: DshWriteSurfaceObservation): string {
  return `dsh-write/${surface.platformVersion}/session-v${surface.sessionFormatVersion}:${sha256Canonical(
    surface as unknown as JsonValue,
  )}`;
}

export const DSH_WRITE_CONTRACT_FINGERPRINT = fingerprint(DSH_RC2_WRITE_SURFACE);

const DISABLED_CAPABILITIES: DisabledDshWriteCapabilities = {
  "append-events": "sessionPersistence has no truncate or replace operation",
  "create-session": "sessionPersistence has no remove or forget operation",
  restore: "sessionPersistence cannot restore an absent or previous artifact",
  "update-archive": "workspaceRegistry exposes archiveSession without an official inverse operation",
  "update-title": "session titles are append-only events without an inverse operation",
};

export function assessDshWriteContract(
  observed: DshWriteSurfaceObservation,
): DshWriteContractAssessment {
  const observedFingerprint = fingerprint(observed);
  if (observedFingerprint !== DSH_WRITE_CONTRACT_FINGERPRINT) {
    return {
      probe: {
        status: "unsupported",
        contract: {
          adapter: "dsh-write",
          platformVersion: observed.platformVersion,
          schemaFingerprint: observedFingerprint,
        },
        capabilities: [],
        issues: [
          {
            code: "ADAPTER_INCOMPATIBLE",
            message: "Observed DSH write service surface does not match the locked 0.1.1-rc.2 contract",
          },
        ],
      },
      disabledCapabilities: DISABLED_CAPABILITIES,
    };
  }
  return {
    probe: {
      status: "degraded",
      contract: {
        adapter: "dsh-write",
        platformVersion: observed.platformVersion,
        schemaFingerprint: observedFingerprint,
      },
      capabilities: ["verify"],
      issues: [
        {
          code: "WRITE_CAPABILITY_UNAVAILABLE",
          message: "Official 0.1.1-rc.2 services cannot reverse a durable session mutation",
        },
      ],
    },
    disabledCapabilities: DISABLED_CAPABILITIES,
  };
}
