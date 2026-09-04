import { readFile, stat } from "node:fs/promises";

import type {
  AdapterContractRef,
  AdapterProbe,
  RegisteredInstance,
} from "@linmu/dsh-session-contracts";
import { sha256Canonical } from "@linmu/dsh-session-domain";

import { parseCodexJsonl } from "./parser.js";
import { resolveContainedRollout, withCodexReadSnapshot } from "./stable-read.js";

export const CODEX_SUPPORTED_VERSION = "0.146.0";
export const CODEX_REQUIRED_THREAD_COLUMNS = [
  ["id", "TEXT", 0, 1], ["rollout_path", "TEXT", 1, 0],
  ["created_at", "INTEGER", 1, 0], ["updated_at", "INTEGER", 1, 0],
  ["source", "TEXT", 1, 0], ["model_provider", "TEXT", 1, 0],
  ["cwd", "TEXT", 1, 0], ["title", "TEXT", 1, 0],
  ["sandbox_policy", "TEXT", 1, 0], ["approval_mode", "TEXT", 1, 0],
  ["tokens_used", "INTEGER", 1, 0], ["has_user_event", "INTEGER", 1, 0],
  ["archived", "INTEGER", 1, 0], ["archived_at", "INTEGER", 0, 0],
  ["git_sha", "TEXT", 0, 0], ["git_branch", "TEXT", 0, 0],
  ["git_origin_url", "TEXT", 0, 0], ["cli_version", "TEXT", 1, 0],
  ["first_user_message", "TEXT", 1, 0], ["agent_nickname", "TEXT", 0, 0],
  ["agent_role", "TEXT", 0, 0], ["memory_mode", "TEXT", 1, 0],
  ["model", "TEXT", 0, 0], ["reasoning_effort", "TEXT", 0, 0],
  ["agent_path", "TEXT", 0, 0], ["created_at_ms", "INTEGER", 0, 0],
  ["updated_at_ms", "INTEGER", 0, 0], ["thread_source", "TEXT", 0, 0],
  ["preview", "TEXT", 1, 0], ["recency_at", "INTEGER", 1, 0],
  ["recency_at_ms", "INTEGER", 1, 0], ["history_mode", "TEXT", 1, 0],
  ["name", "TEXT", 0, 0], ["is_pinned", "INTEGER", 1, 0],
  ["thread_section_id", "TEXT", 0, 0], ["section_position", "INTEGER", 0, 0],
  ["section_entered_at_ms", "INTEGER", 0, 0], ["project_id", "TEXT", 0, 0],
] as const;
export const CODEX_REQUIRED_ENVELOPES = ["response_item", "session_meta"] as const;
export const CODEX_SUPPORTED_ENVELOPES = [...CODEX_REQUIRED_ENVELOPES, "compacted"] as const;
const schemaHex = sha256Canonical({
  tables: [{ name: "threads", columns: CODEX_REQUIRED_THREAD_COLUMNS }],
  sessionIndex: ["id", "thread_name", "updated_at"],
  envelopes: [...CODEX_SUPPORTED_ENVELOPES],
});
export const CODEX_SCHEMA_FINGERPRINT = `codex-read/0.146.0/schema-3:${schemaHex}`;

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
    const snapshot = withCodexReadSnapshot(instance.root, (database) => ({
      columns: (
        database.prepare("PRAGMA table_info(threads)").all() as unknown as Array<{
          readonly name: string;
          readonly type: string;
          readonly notnull: number;
          readonly pk: number;
        }>
      ).map((row) => [row.name, row.type, row.notnull, row.pk] as const),
      rolloutPath: (
        database.prepare("SELECT rollout_path FROM threads ORDER BY id LIMIT 1").get() as
          | { readonly rollout_path: string }
          | undefined
      )?.rollout_path,
    }));
    const { columns, rolloutPath } = snapshot;

    if (JSON.stringify(columns) !== JSON.stringify(CODEX_REQUIRED_THREAD_COLUMNS)) {
      return {
        status: "unsupported",
        contract: contract(instance.platformVersion, "unsupported-schema"),
        capabilities: [],
        issues: [{
          code: "ADAPTER_INCOMPATIBLE",
          message: `Codex threads schema fingerprint mismatch: ${schemaHex.slice(0, 12)}:${sha256Canonical(columns).slice(0, 12)}`,
        }],
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
    if (!CODEX_REQUIRED_ENVELOPES.every((type) => observedTypes.has(type))) {
      throw new Error("Codex probe sample is missing required envelope names");
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
