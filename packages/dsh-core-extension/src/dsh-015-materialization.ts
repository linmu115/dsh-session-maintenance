import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface CoreHostMaterializationProbe {
  readonly status: "compatible" | "unsupported";
  readonly sourceHash: string;
  readonly artifactHash: string;
  readonly issues: readonly { readonly code: string; readonly message: string }[];
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function normalizedTextHash(bytes: Uint8Array): string {
  return sha256(Buffer.from(Buffer.from(bytes).toString("utf8").replaceAll("\r\n", "\n"), "utf8"));
}

export async function probeBuiltDsh015CoreHost(expected: {readonly sourceHash:string; readonly artifactHash:string}): Promise<CoreHostMaterializationProbe> {
  try {
    let artifact: Uint8Array | undefined;
    let lastError: unknown;
    let developmentFallback = false;
    for (const [index, candidate] of [
      new URL("./dsh-015-host.js", import.meta.url),
      new URL("../dist/dsh-015-host.js", import.meta.url),
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
            (await readFile(new URL("./dsh-015-host.ts", import.meta.url), "utf8")).replaceAll(
              "\r\n",
              "\n",
            ),
            "utf8",
          ),
        )
      : expected.sourceHash;
    const artifactHash = normalizedTextHash(artifact);
    if (
      sourceHash !== expected.sourceHash ||
      artifactHash !== expected.artifactHash
    ) {
      return {
        status: "unsupported",
        sourceHash,
        artifactHash,
        issues: [
          {
            code: "ADAPTER_INCOMPATIBLE",
            message: "Materialized 0.1.5 RC2 Core host does not match its build-time lock",
          },
        ],
      };
    }
    return {
      status: "compatible",
      ...expected,
      issues: [],
    };
  } catch (error) {
    return {
      status: "unsupported",
      sourceHash: expected.sourceHash,
      artifactHash: "unavailable",
      issues: [
        {
          code: "ADAPTER_INCOMPATIBLE",
          message: `Materialized 0.1.5 RC2 Core host is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}
