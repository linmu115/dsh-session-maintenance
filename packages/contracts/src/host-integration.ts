import { z } from "zod";
import type { IntegrationTarget, RegisteredInstance } from "./index.js";
import type { DshIntegrationConnectionKind, StandaloneInstance } from "./standalone-instance.js";
export interface DiscoveredIntegration {
  readonly target: IntegrationTarget;
  readonly instanceId: string;
  /**
   * Which connection source produced this target. Engine decides from it whether
   * the binding owns a Launcher hook and the instance-side startup gate; a
   * `directory` target owns neither. See {@link DshIntegrationConnectionKind}.
   */
  readonly connectionKind: DshIntegrationConnectionKind;
  /**
   * Startup gate. Covers the instance identity and the actual integration
   * contract: who the instance is, that the host and attestation are intact,
   * which adapter and runtime version apply, which roots are read, the effective
   * user patch layers that can disable session services, and the Maintenance
   * integration plugin's own resolved manifest and bundle patch. Ordinary
   * business plugin composition is deliberately absent so installing, removing
   * or upgrading such a plugin cannot block a launch on its own — see
   * {@link pluginInventory} for that record.
   */
  readonly fingerprint: string;
  /**
   * Diagnostically useful ordinary plugin composition, recorded but never
   * gating. Kept separate from {@link fingerprint} so a changed plugin set can be
   * explained and displayed without becoming a startup precondition. Real
   * incompatibilities still gate through their own checks — {@link pluginReady}
   * and the declared host, adapter and session-format declarations — never
   * through a difference in this record.
   */
  readonly pluginInventory?: string;
  readonly launcherDataRoot: string | null;
  readonly homeRoot: string;
  readonly versionRoot: string | null;
  readonly profileRoot: string | null;
  readonly cliPath: string | null;
  readonly packageVersions: Readonly<Record<string, string>>;
  readonly pluginReady: boolean;
  readonly pluginIssue?: import('./host-plugin-compatibility.js').HostPluginIssue;
  readonly runtimeCapabilities?: readonly string[];
  readonly coreBinding?: {readonly path:string;readonly sha256:string};
  readonly codexSource?: RegisteredInstance;
  readonly codexRegistered?: boolean;
}
export interface DiscoveredIntegrations { readonly launcherDetected: boolean; readonly targets: DiscoveredIntegration[] }

/**
 * The instance-side workspace-level entry asking for one workspace to be joined.
 *
 * The instance states which workspace it is and where its sessions live; the
 * Engine decides what that means, because it is the side that can read the
 * instance's sessions and write them into Maintenance's own storage.
 */
export const workspaceJoinRequestSchema = z.strictObject({
  instanceId: z.string().min(1).max(128),
  profileId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(512),
  workspaceName: z.string().min(1).max(1_000),
  /** The workspace's directory, which names the project directory inside the instance. */
  workspacePath: z.string().min(1).max(32_768),
});
export type WorkspaceJoinRequest = z.infer<typeof workspaceJoinRequestSchema>;

export const workspaceJoinReceiptSchema = z.strictObject({
  workspaceId: z.string().min(1),
  created: z.boolean(),
  mapped: z.array(z.string()),
  alreadyPresent: z.array(z.string()),
  failures: z.array(z.strictObject({ nativeSessionId: z.string(), reason: z.string() })),
});
export type WorkspaceJoinReceipt = z.infer<typeof workspaceJoinReceiptSchema>;

/** Read-only host inspection. Registration, leases and process control remain in Engine. */
export interface InstanceHostIntegration {
  inspect(config: StandaloneInstance): Promise<DiscoveredIntegration>;
}

/**
 * What the operator is choosing when connecting an instance by folder.
 *
 * The selection is the DSH Home root and never a profile folder: one Home can
 * hold several profiles, and those can only be told apart from inside the Home.
 */
export const INSTANCE_FOLDER_HINT = "选择 DSH Home 根目录，其中包含 profiles/ 与 sessions/；同一 Home 下的多个 profile 会被分别识别";

/** One profile found inside the selected Home; it becomes its own connection scope. */
export const instanceHomeProfileSchema = z.strictObject({
  profileId: z.string().min(1).max(128),
  root: z.string().min(1),
  /** The profile enables the official Web bundle, so it can be attached as a Web instance. */
  web: z.boolean(),
});

/**
 * A directory under `profiles/` that is recognized as a profile folder but cannot be attached.
 *
 * `profiles/` is not a list of profiles — DSH keeps generated directories there too
 * (`node_modules`), and an install can hold profiles that name no DSH program. Those are
 * skipped instead of failing the whole selection, and the operator is told why the list of
 * recognized profiles is shorter than the folders they can see.
 */
export const skippedProfileEntrySchema = z.strictObject({
  entry: z.string().min(1).max(128),
  reason: z.string().min(1),
});

/** A read-only description of a selected DSH Home, derived from the folder alone. */
export const instanceHomeInspectionSchema = z.strictObject({
  homeRoot: z.string().min(1),
  /** Offered from the folder name; the caller still decides the final instance id. */
  suggestedInstanceId: z.string().min(1),
  profiles: z.array(instanceHomeProfileSchema).min(1),
  /** Profile folders that were skipped, in name order. Absent when every folder was usable. */
  skippedEntries: z.array(skippedProfileEntrySchema).optional(),
  runtimeVersion: z.string().min(1),
  /** `null` when the folder only states a version and no installed program can be located. */
  versionRoot: z.string().min(1).nullable(),
  cliPath: z.string().min(1).nullable(),
  declaredRuntimeVersion: z.string().min(1).nullable(),
});
export type InstanceHomeProfile = z.infer<typeof instanceHomeProfileSchema>;
export type SkippedProfileEntry = z.infer<typeof skippedProfileEntrySchema>;
export type InstanceHomeInspection = z.infer<typeof instanceHomeInspectionSchema>;

/**
 * Result of the folder picker. A cancelled selection is a normal outcome, not an
 * error, and the hint travels with both outcomes so the selection bar can show it
 * before and after a choice.
 */
export const selectInstanceFolderResponseSchema = z.union([
  z.strictObject({ hint: z.string().min(1), cancelled: z.literal(true) }),
  z.strictObject({ hint: z.string().min(1), cancelled: z.literal(false), inspection: instanceHomeInspectionSchema }),
]);
export type SelectInstanceFolderResponse = z.infer<typeof selectInstanceFolderResponseSchema>;
