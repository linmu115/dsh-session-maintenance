import type { DshCoreProbe } from "@linmu/dsh-core-extension";
import type { RegisteredInstance, WriteProbe } from "@linmu/dsh-session-contracts";

export const DSH_WRITE_ADAPTER_ID = "dsh-write-core";

export function dshWriteProbe(instance: RegisteredInstance, core: DshCoreProbe): WriteProbe {
  if (instance.platform !== "dsh" || instance.platformVersion !== "0.1.1-rc.2") {
    return {
      status: "unsupported",
      contract: {
        adapter: DSH_WRITE_ADAPTER_ID,
        platformVersion: instance.platformVersion,
        schemaFingerprint: core.contractFingerprint,
      },
      capabilities: [],
      issues: [
        {
          code: "ADAPTER_INCOMPATIBLE",
          message: `DSH write Adapter only supports 0.1.1-rc.2, received ${instance.platformVersion}`,
        },
      ],
    };
  }
  return {
    status: core.status,
    contract: {
      adapter: DSH_WRITE_ADAPTER_ID,
      platformVersion: instance.platformVersion,
      schemaFingerprint: core.contractFingerprint,
    },
    capabilities: core.capabilities,
    issues: core.issues,
  };
}
