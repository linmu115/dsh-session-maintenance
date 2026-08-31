import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type {
  CanonicalMigrationClassification,
  CanonicalMigrationPreview,
  CanonicalMigrationSourceFile,
  JsonValue,
} from "@linmu/dsh-session-contracts";
import { canonicalJson, sha256Canonical } from "@linmu/dsh-session-domain";

interface MirrorRow {
  readonly logical_session_id: string;
  readonly codex_binding_id: string | null;
  readonly dsh_binding_id: string | null;
  readonly common_version_id: string | null;
  readonly codex_version_id: string | null;
  readonly dsh_version_id: string | null;
}

interface SessionRow {
  readonly id: string;
}

interface WorkspaceRow {
  readonly binding_id: string;
  readonly workspace_id: string;
}

interface VersionRow {
  readonly version: number;
}

interface CountRow {
  readonly count: number;
}

async function sourceFiles(path: string): Promise<readonly CanonicalMigrationSourceFile[]> {
  const paths = [path, `${path}-wal`, `${path}-shm`];
  const files: CanonicalMigrationSourceFile[] = [];
  for (const candidate of paths) {
    try {
      const bytes = await readFile(candidate);
      files.push({
        path: candidate,
        digest: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }
  return files;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function derivedPreviewId(row: MirrorRow): string {
  return `ls_${sha256Canonical({
    migration: "v6-codex-derived-preview",
    logicalSessionId: row.logical_session_id,
    baseVersionId: row.common_version_id,
    dshVersionId: row.dsh_version_id,
  }).slice(0, 24)}`;
}

function classify(
  row: MirrorRow,
  workspaceIds: readonly string[],
): CanonicalMigrationClassification {
  const base = {
    logicalSessionId: row.logical_session_id,
    workspaceIds,
  };
  if (row.codex_binding_id !== null && row.dsh_binding_id === null) {
    return {
      ...base,
      disposition: "codex-mirror",
      reasonCode: "CODEX_ONLY",
      proposedSessionIds: [row.logical_session_id],
    };
  }
  if (row.codex_binding_id === null && row.dsh_binding_id !== null) {
    return {
      ...base,
      disposition: "maintenance-native",
      reasonCode: "DSH_ONLY",
      proposedSessionIds: [row.logical_session_id],
    };
  }
  if (row.codex_binding_id === null || row.dsh_binding_id === null) {
    return {
      ...base,
      disposition: "unclassified",
      reasonCode: "INCOMPLETE_MIRROR_STATE",
      proposedSessionIds: [],
    };
  }
  if (
    row.codex_version_id !== null &&
    row.codex_version_id === row.dsh_version_id
  ) {
    return {
      ...base,
      disposition: "codex-mirror",
      reasonCode: "MIRROR_EQUAL",
      proposedSessionIds: [row.logical_session_id],
    };
  }
  if (
    row.common_version_id !== null &&
    row.dsh_version_id === row.common_version_id &&
    row.codex_version_id !== null &&
    row.codex_version_id !== row.common_version_id
  ) {
    return {
      ...base,
      disposition: "codex-mirror",
      reasonCode: "CODEX_AHEAD",
      proposedSessionIds: [row.logical_session_id],
    };
  }
  if (
    row.common_version_id !== null &&
    row.codex_version_id === row.common_version_id &&
    row.dsh_version_id !== null &&
    row.dsh_version_id !== row.common_version_id
  ) {
    return {
      ...base,
      disposition: "codex-mirror-with-derived-child",
      reasonCode: "DSH_AHEAD_DERIVE",
      proposedSessionIds: [row.logical_session_id, derivedPreviewId(row)],
    };
  }
  if (
    row.common_version_id !== null &&
    row.codex_version_id !== null &&
    row.dsh_version_id !== null &&
    row.codex_version_id !== row.common_version_id &&
    row.dsh_version_id !== row.common_version_id &&
    row.codex_version_id !== row.dsh_version_id
  ) {
    return {
      ...base,
      disposition: "review-required",
      reasonCode: "DIVERGED_REQUIRES_REVIEW",
      proposedSessionIds: [],
    };
  }
  return {
    ...base,
    disposition: "unclassified",
    reasonCode: "INCOMPLETE_MIRROR_STATE",
    proposedSessionIds: [],
  };
}

export async function previewCanonicalMigration(input: {
  readonly database: DatabaseSync;
  readonly sourceDatabasePath: string;
  readonly candidateDatabasePath: string;
}): Promise<CanonicalMigrationPreview> {
  const sourceDatabasePath = resolve(input.sourceDatabasePath);
  const candidateDatabasePath = resolve(input.candidateDatabasePath);
  if (sourceDatabasePath === candidateDatabasePath) {
    throw new TypeError("Canonical migration candidate must not overwrite the source database");
  }
  const before = await sourceFiles(sourceDatabasePath);
  const sourceSchemaVersion = (input.database
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as unknown as VersionRow).version;
  const sessions = input.database
    .prepare("SELECT id FROM logical_sessions ORDER BY id")
    .all() as unknown as SessionRow[];
  const mirrors = input.database
    .prepare(
      `SELECT logical_session_id, codex_binding_id, dsh_binding_id, common_version_id,
              codex_version_id, dsh_version_id
       FROM native_mirrors ORDER BY logical_session_id`,
    )
    .all() as unknown as MirrorRow[];
  const workspaces = input.database
    .prepare("SELECT binding_id, workspace_id FROM binding_workspaces ORDER BY binding_id")
    .all() as unknown as WorkspaceRow[];
  const workspaceByBinding = new Map<string, string[]>();
  for (const row of workspaces) {
    const values = workspaceByBinding.get(row.binding_id) ?? [];
    values.push(row.workspace_id);
    workspaceByBinding.set(row.binding_id, values);
  }
  const classifications: CanonicalMigrationClassification[] = [];
  const mirrored = new Set<string>();
  for (const row of mirrors) {
    mirrored.add(row.logical_session_id);
    const workspaceIds = [...new Set([
      ...(row.codex_binding_id === null ? [] : workspaceByBinding.get(row.codex_binding_id) ?? []),
      ...(row.dsh_binding_id === null ? [] : workspaceByBinding.get(row.dsh_binding_id) ?? []),
    ])].sort();
    classifications.push(classify(row, workspaceIds));
  }
  for (const session of sessions) {
    if (!mirrored.has(session.id)) {
      classifications.push({
        logicalSessionId: session.id,
        disposition: "unclassified",
        reasonCode: "NO_NATIVE_MIRROR",
        proposedSessionIds: [],
        workspaceIds: [],
      });
    }
  }
  classifications.sort((left, right) => left.logicalSessionId.localeCompare(right.logicalSessionId));
  const counts = {
    sourceLogicalSessions: (input.database
      .prepare("SELECT COUNT(*) AS count FROM logical_sessions")
      .get() as unknown as CountRow).count,
    codexMirror: classifications.filter((item) =>
      item.disposition === "codex-mirror" || item.disposition === "codex-mirror-with-derived-child"
    ).length,
    maintenanceNative: classifications.filter((item) => item.disposition === "maintenance-native").length,
    codexDerived: classifications.filter((item) => item.disposition === "codex-mirror-with-derived-child").length,
    reviewRequired: classifications.filter((item) => item.disposition === "review-required").length,
    unclassified: classifications.filter((item) => item.disposition === "unclassified").length,
  };
  const after = await sourceFiles(sourceDatabasePath);
  if (canonicalJson(before as unknown as JsonValue) !== canonicalJson(after as unknown as JsonValue)) {
    throw new Error("Canonical migration preview changed the source database files");
  }
  return {
    sourceSchemaVersion,
    sourceDigest: sha256Canonical(before as unknown as JsonValue),
    sourceFiles: before,
    candidate: {
      path: candidateDatabasePath,
      exists: await exists(candidateDatabasePath),
      created: false,
    },
    rollback: {
      sourcePreserved: true,
      activationRequired: true,
      strategy: "candidate-copy-and-pointer-swap",
    },
    counts,
    classifications,
  };
}
