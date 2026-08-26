import { readFile, stat } from "node:fs/promises";

import type {
  AdapterContractRef,
  AdapterProbe,
  RegisteredInstance,
} from "@linmu/dsh-session-contracts";
import { sha256Canonical } from "@linmu/dsh-session-domain";

import { parseCodexJsonl } from "./parser.js";
import { openCodexDatabase, resolveContainedRollout } from "./stable-read.js";

export const CODEX_SUPPORTED_VERSION = "0.146.0";
export const CODEX_REQUIRED_THREAD_COLUMNS = [
  "archived",
  "created_at",
  "cwd",
  "id",
  "name",
  "rollout_path",
  "title",
  "updated_at",
] as const;
const SUPPORTED_ENVELOPES = ["response_item", "session_meta"] as const;
const schemaHex = sha256Canonical({
  tables: [{ name: "threads", columns: [...CODEX_REQUIRED_THREAD_COLUMNS] }],
  envelopes: [...SUPPORTED_ENVELOPES],
});
export const CODEX_SCHEMA_FINGERPRINT = `codex-read/0.146.0/schema-1:${schemaHex}`;

const contract = (version: string, fingerprint = CODEX_SCHEMA_FINGERPRINT): AdapterContractRef => ({
  adapter: "codex-read",
  platformVersion: version,
  schemaFingerprint: fingerprint,
});

export async function probeCodexInstance(
  instance: RegisteredInstance,
  fixtureGuard: ((root: string) => void) | undefined,
  onProbeRead: () => void,
): Promise<AdapterProbe> {
  fixtureGuard?.(instance.root);
  if (instance.platform !== "codex" || instance.platformVersion !== CODEX_SUPPORTED_VERSION) {
    return {
      status: "unsupported",
      contract: contract(instance.platformVersion, "unsupported"),
      capabilities: [],
      issues: [
        {
          code: "ADAPTER_INCOMPATIBLE",
          message: `Unsupported Codex version: ${instance.platformVersion}`,
        },
      ],
    };
  }

  try {
    const database = openCodexDatabase(instance.root);
    let columns: string[];
    let rolloutPath: string | undefined;
    try {
      columns = (
        database.prepare("PRAGMA table_info(threads)").all() as unknown as Array<{ readonly name: string }>
      )
        .map((row) => row.name)
        .sort();
      rolloutPath = (
        database.prepare("SELECT rollout_path FROM threads ORDER BY id LIMIT 1").get() as
          | { readonly rollout_path: string }
          | undefined
      )?.rollout_path;
    } finally {
      database.close();
    }

    if (JSON.stringify(columns) !== JSON.stringify(CODEX_REQUIRED_THREAD_COLUMNS)) {
      return {
        status: "unsupported",
        contract: contract(instance.platformVersion, "unsupported-schema"),
        capabilities: [],
        issues: [{ code: "ADAPTER_INCOMPATIBLE", message: "Codex threads schema fingerprint mismatch" }],
      };
    }
    if (rolloutPath === undefined) {
      throw new Error("Codex fixture has no rollout sample");
    }
    const resolved = await resolveContainedRollout(instance.root, rolloutPath);
    if ((await stat(resolved)).size > 1024 * 1024) {
      throw new Error("Codex probe sample exceeds 1 MiB");
    }
    onProbeRead();
    const observedTypes = new Set(parseCodexJsonl(await readFile(resolved)).map((item) => item.type));
    if (!SUPPORTED_ENVELOPES.every((type) => observedTypes.has(type))) {
      throw new Error("Codex probe sample is missing supported envelope names");
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
      contract: contract(instance.platformVersion, "unsupported-schema"),
      capabilities: [],
      issues: [
        {
          code: "ADAPTER_INCOMPATIBLE",
          message: error instanceof Error ? error.message : "Unknown Codex schema probe failure",
        },
      ],
    };
  }
}
