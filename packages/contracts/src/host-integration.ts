import type { IntegrationTarget, RegisteredInstance } from "./index.js";
import type { StandaloneInstance } from "./standalone-instance.js";
export interface DiscoveredIntegration {
  readonly target: IntegrationTarget;
  readonly instanceId: string;
  readonly fingerprint: string;
  readonly launcherDataRoot: string | null;
  readonly homeRoot: string;
  readonly versionRoot: string | null;
  readonly profileRoot: string | null;
  readonly cliPath: string | null;
  readonly packageVersions: Readonly<Record<string, string>>;
  readonly pluginReady: boolean;
  readonly runtimeCapabilities?: readonly string[];
  readonly coreBinding?: {readonly path:string;readonly sha256:string};
  readonly codexSource?: RegisteredInstance;
  readonly codexRegistered?: boolean;
}
export interface DiscoveredIntegrations { readonly launcherDetected: boolean; readonly targets: DiscoveredIntegration[] }

/** Read-only host inspection. Registration, leases and process control remain in Engine. */
export interface InstanceHostIntegration {
  inspect(config: StandaloneInstance): Promise<DiscoveredIntegration>;
}
