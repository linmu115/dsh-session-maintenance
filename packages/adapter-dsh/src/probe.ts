import type { AdapterContractRef, AdapterProbe, RegisteredInstance } from "@linmu/dsh-session-contracts";
import { sha256Canonical } from "@linmu/dsh-session-domain";

import { iterateDshCatalog, type DshReadHooks } from "./reader.js";

export const DSH_SUPPORTED_VERSION = "0.1.1-rc.2";
const schemaHex = sha256Canonical({
  header: ["createdAt", "cwd", "delegationDepth", "id", "type", "version"],
  projection: { name: "session_projcache", version: 3, table: "sessions", title: "rows.title.val" },
  type: "session",
  version: 0,
  workspace: { name: "workspace", version: 2, archive: "global.archivedSessionIds", table: "workspaces" },
});
export const DSH_SCHEMA_FINGERPRINT = `dsh-read/0.1.1-rc.2/session-v0:${schemaHex}`;

function contract(version: string, fingerprint = DSH_SCHEMA_FINGERPRINT): AdapterContractRef {
  return { adapter: "dsh-read", platformVersion: version, schemaFingerprint: fingerprint };
}

export async function probeDshInstance(
  instance: RegisteredInstance,
  hooks: DshReadHooks,
): Promise<AdapterProbe> {
  hooks.fixtureGuard?.(instance.root);
  if (instance.platform !== "dsh" || instance.platformVersion !== DSH_SUPPORTED_VERSION) {
    return {
      status: "unsupported",
      contract: contract(instance.platformVersion, "unsupported"),
      capabilities: [],
      issues: [{ code: "ADAPTER_INCOMPATIBLE", message: `Unsupported DSH version: ${instance.platformVersion}` }],
    };
  }
  try {
    let sampled = false;
    for await (const _entry of iterateDshCatalog(instance, undefined, hooks)) {
      sampled = true;
      break;
    }
    if (!sampled) {
      throw new Error("DSH profile has no session header sample");
    }
    return {
      status: "compatible",
      contract: contract(instance.platformVersion),
      capabilities: ["list", "observe", "normalize", "verify-read"],
      issues: [],
    };
  } catch (error) {
    return {
      status: "unsupported",
      contract: contract(instance.platformVersion, "unsupported-session-schema"),
      capabilities: [],
      issues: [
        {
          code: "ADAPTER_INCOMPATIBLE",
          message: error instanceof Error ? error.message : "Unknown DSH schema probe failure",
        },
      ],
    };
  }
}
