import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface CoreHostMaterializationProbe {
  readonly status: "compatible" | "unsupported";
  readonly sourceHash: string;
  readonly artifactHash: string;
  readonly issues: readonly { readonly code: string; readonly message: string }[];
}

export const RC2_CORE_HOST_MATERIALIZATION = {
  sourceHash: "sha256:d5e0b4bcc630e50c7c31bd6a06a5aaac16cb0d0024e3743bcc0a60bb86bbd4cd",
  artifactHash: "sha256:87ae13c49c7cb06eac44f676033e168efc2e3c118eae4d46896c55ce4d44ec15",
} as const;

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function probeBuiltRc2CoreHost(): Promise<CoreHostMaterializationProbe> {
  try {
    let artifact: Uint8Array | undefined;
    let lastError: unknown;
    let developmentFallback = false;
    for (const [index, candidate] of [
      new URL("./rc2-host.js", import.meta.url),
      new URL("../dist/rc2-host.js", import.meta.url),
    ].entries()) {
      try {
        artifact = await readFile(candidate);
        developmentFallback = index === 1;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (artifact === undefined) throw lastError;
    const sourceHash = developmentFallback
      ? sha256(
          Buffer.from(
            (await readFile(new URL("./rc2-host.ts", import.meta.url), "utf8")).replaceAll(
              "\r\n",
              "\n",
            ),
            "utf8",
          ),
        )
      : RC2_CORE_HOST_MATERIALIZATION.sourceHash;
    const artifactHash = sha256(artifact);
    if (
      sourceHash !== RC2_CORE_HOST_MATERIALIZATION.sourceHash ||
      artifactHash !== RC2_CORE_HOST_MATERIALIZATION.artifactHash
    ) {
      return {
        status: "unsupported",
        sourceHash,
        artifactHash,
        issues: [
          {
            code: "ADAPTER_INCOMPATIBLE",
            message: "Materialized rc.2 Core host does not match its build-time lock",
          },
        ],
      };
    }
    return {
      status: "compatible",
      ...RC2_CORE_HOST_MATERIALIZATION,
      issues: [],
    };
  } catch (error) {
    return {
      status: "unsupported",
      sourceHash: RC2_CORE_HOST_MATERIALIZATION.sourceHash,
      artifactHash: "unavailable",
      issues: [
        {
          code: "ADAPTER_INCOMPATIBLE",
          message: `Materialized rc.2 Core host is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}
