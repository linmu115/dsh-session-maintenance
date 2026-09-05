import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type {
  CanonicalMigrationClassification,
  CanonicalMigrationPreview,
  CanonicalMigrationSourceFile,
  CanonicalEventKind,
  CanonicalEventRole,
  CanonicalEventV1,
  JsonValue,
  NormalizedEvent,
  NormalizedSession,
} from "@linmu/dsh-session-contracts";
import { normalizedSessionSchema } from "@linmu/dsh-session-contracts";
import { canonicalJson, sha256Canonical } from "@linmu/dsh-session-domain";

import { openMaintenanceDatabase } from "./database.js";
import { ZstdContentObjectStore } from "./object-store.js";
import { saveVersionMetadataSnapshot } from "./version-metadata.js";

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

interface BindingRow {
  readonly id: string;
  readonly logical_session_id: string;
  readonly platform: "codex" | "dsh";
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

interface ActivationSessionRow {
  readonly id: string;
  readonly display_title: string;
  readonly labels_json: string;
  readonly archived: number;
  readonly created_at: string;
  readonly canonical_version_id: string | null;
}

interface ActivationVersionRow {
  readonly id: string;
  readonly body_object: string;
  readonly created_at: string;
}

interface WorkspaceDisplayRow {
  readonly workspace_id: string;
  readonly display_name: string;
}

interface ActivationRefRow {
  readonly logical_session_id: string;
  readonly platform: "codex" | "dsh";
  readonly version_id: string;
  readonly observed_at: string;
}

export interface CanonicalMigrationActivation {
  readonly sourceDatabasePath: string;
  readonly candidateDatabasePath: string;
  readonly archiveDatabasePath: string;
  readonly sourceDigest: string;
  readonly candidateDigest: string;
  readonly schemaVersion: number;
  readonly counts: {
    readonly logicalSessions: number;
    readonly canonicalEvents: number;
    readonly logicalWorkspaces: number;
    readonly workspaceMemberships: number;
  };
  readonly sourcePreserved: true;
  readonly pointerSwitchRequired: true;
}

async function sourceFiles(path: string): Promise<readonly CanonicalMigrationSourceFile[]> {
  const paths = [path, `${path}-wal`, `${path}-shm`];
  const files: CanonicalMigrationSourceFile[] = [];
  for (const candidate of paths) {
    try {
      const info = await stat(candidate);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(candidate)) hash.update(chunk);
      files.push({
        path: candidate,
        digest: hash.digest("hex"),
        size: info.size,
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

function mappedKind(event: NormalizedEvent): CanonicalEventKind {
  if (event.kind === "attachment") return "attachment";
  if (event.kind === "metadata") return "system-metadata";
  if (event.kind === "tool-import") return event.role === "tool" ? "tool-result" : "opaque-unknown";
  if (event.role === "user") return "user-message";
  if (event.role === "assistant") return "assistant-message";
  if (event.role === "system") return "system-message";
  if (event.role === "tool") return "tool-result";
  return "opaque-unknown";
}

function mappedRole(event: NormalizedEvent): CanonicalEventRole {
  return event.role;
}

function canonicalEvent(logicalSessionId: string, event: NormalizedEvent): CanonicalEventV1 {
  const content = {
    text: event.content,
    attachments: event.attachments.map((attachment) => ({
      name: attachment.name,
      ...(attachment.mediaType === undefined ? {} : { mediaType: attachment.mediaType }),
      source: attachment.source,
    })),
  } as JsonValue;
  const sourceType = typeof event.extensions.sourceType === "string"
    ? event.extensions.sourceType
    : undefined;
  const dshEnvelope = event.source.platform === "dsh" && event.extensions.dshEvent !== undefined
    ? event.extensions.dshEvent
    : null;
  return {
    schemaVersion: 1,
    id: event.id,
    logicalSessionId,
    sequence: event.sequence,
    kind: mappedKind(event),
    role: mappedRole(event),
    content,
    source: {
      platform: event.source.platform,
      instanceId: event.source.instanceId,
      sessionId: event.source.sessionId,
      eventId: event.source.eventId ?? null,
      cursor: String(event.source.sequence),
    },
    contentDigest: sha256Canonical(content),
    rawPayload: dshEnvelope,
    extensions: {
      migratedFrom: "normalized-session-v1",
      normalizedEventKind: event.kind,
      normalizedExtensionsDigest: sha256Canonical(event.extensions as unknown as JsonValue),
      ...(sourceType === undefined ? {} : { sourceType }),
      ...(event.parentId === null ? {} : { parentEventId: event.parentId }),
    },
  } as unknown as CanonicalEventV1;
}

function databaseCount(database: DatabaseSync, table: string): number {
  if (!/^[a-z_]+$/u.test(table)) throw new TypeError(`Unsafe table name: ${table}`);
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as unknown as CountRow).count;
}

function migrationDigest(files: readonly CanonicalMigrationSourceFile[]): string {
  return sha256Canonical(files as unknown as JsonValue);
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
  const bindings = input.database
    .prepare("SELECT id, logical_session_id, platform FROM platform_bindings ORDER BY logical_session_id, id")
    .all() as unknown as BindingRow[];
  const workspaces = input.database
    .prepare("SELECT binding_id, workspace_id FROM binding_workspaces ORDER BY binding_id")
    .all() as unknown as WorkspaceRow[];
  const workspaceByBinding = new Map<string, string[]>();
  for (const row of workspaces) {
    const values = workspaceByBinding.get(row.binding_id) ?? [];
    values.push(row.workspace_id);
    workspaceByBinding.set(row.binding_id, values);
  }
  const bindingsBySession = new Map<string, BindingRow[]>();
  for (const binding of bindings) {
    const values = bindingsBySession.get(binding.logical_session_id) ?? [];
    values.push(binding);
    bindingsBySession.set(binding.logical_session_id, values);
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
      const sessionBindings = bindingsBySession.get(session.id) ?? [];
      const platforms = new Set(sessionBindings.map((binding) => binding.platform));
      const workspaceIds = [...new Set(sessionBindings.flatMap((binding) => workspaceByBinding.get(binding.id) ?? []))].sort();
      if (platforms.size === 1 && platforms.has("codex")) {
        classifications.push({
          logicalSessionId: session.id,
          disposition: "codex-mirror",
          reasonCode: "CODEX_ONLY",
          proposedSessionIds: [session.id],
          workspaceIds,
        });
        continue;
      }
      if (platforms.size === 1 && platforms.has("dsh")) {
        classifications.push({
          logicalSessionId: session.id,
          disposition: "maintenance-native",
          reasonCode: "DSH_ONLY",
          proposedSessionIds: [session.id],
          workspaceIds,
        });
        continue;
      }
      classifications.push({
        logicalSessionId: session.id,
        disposition: platforms.size > 1 ? "review-required" : "unclassified",
        reasonCode: platforms.size > 1 ? "INCOMPLETE_MIRROR_STATE" : "NO_NATIVE_MIRROR",
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

/**
 * Builds and validates a canonical candidate without replacing the source.
 * The caller performs the separate atomic config-pointer switch only after this
 * function returns successfully.
 */
export async function activateCanonicalMigration(input: {
  readonly database: DatabaseSync;
  readonly sourceDatabasePath: string;
  readonly candidateDatabasePath: string;
  readonly archiveDatabasePath: string;
  readonly expectedSourceDigest: string;
  readonly onStatus?: (stage: string, detail: JsonValue) => void;
}): Promise<CanonicalMigrationActivation> {
  const sourceDatabasePath = resolve(input.sourceDatabasePath);
  const candidateDatabasePath = resolve(input.candidateDatabasePath);
  const archiveDatabasePath = resolve(input.archiveDatabasePath);
  if (new Set([sourceDatabasePath, candidateDatabasePath, archiveDatabasePath]).size !== 3) {
    throw new TypeError("Canonical source, candidate and archive paths must be distinct");
  }
  if (await exists(candidateDatabasePath)) throw new Error(`Canonical migration candidate already exists: ${candidateDatabasePath}`);
  if (await exists(archiveDatabasePath)) throw new Error(`Canonical migration archive already exists: ${archiveDatabasePath}`);

  const preview = await previewCanonicalMigration({
    database: input.database,
    sourceDatabasePath,
    candidateDatabasePath,
  });
  if (preview.sourceDigest !== input.expectedSourceDigest) {
    throw new Error("Canonical migration source changed after preview; run a new read-only preview");
  }
  if (preview.counts.reviewRequired !== 0 || preview.counts.unclassified !== 0) {
    throw new Error("Canonical migration has unresolved classifications; activation refused");
  }
  const wal = preview.sourceFiles.find((file) => file.path === `${sourceDatabasePath}-wal`);
  if (wal !== undefined && wal.size !== 0) {
    throw new Error("Canonical migration source has pending WAL writes; stop the active Engine and preview again");
  }
  input.onStatus?.("migration.preview.verified", preview.counts as unknown as JsonValue);

  const classifications = new Map(preview.classifications.map((item) => [item.logicalSessionId, item]));
  if ([...classifications.values()].some((item) => item.disposition === "codex-mirror-with-derived-child")) {
    throw new Error("Legacy DSH-ahead mirror derivations require explicit review before canonical activation");
  }
  const sessions = input.database.prepare(
    `SELECT id, display_title, labels_json, archived, created_at, canonical_version_id
     FROM logical_sessions ORDER BY id`,
  ).all() as unknown as ActivationSessionRow[];
  const mirrors = input.database.prepare(
    `SELECT logical_session_id, codex_binding_id, dsh_binding_id, common_version_id,
            codex_version_id, dsh_version_id
     FROM native_mirrors ORDER BY logical_session_id`,
  ).all() as unknown as MirrorRow[];
  const mirrorBySession = new Map(mirrors.map((row) => [row.logical_session_id, row]));
  const refs = input.database.prepare(
    `SELECT pb.logical_session_id, pb.platform, pr.version_id, pr.observed_at
     FROM platform_bindings pb
     JOIN platform_refs pr ON pr.binding_id = pb.id
     ORDER BY pb.logical_session_id, pr.observed_at DESC, pb.id`,
  ).all() as unknown as ActivationRefRow[];
  const refBySessionPlatform = new Map<string, ActivationRefRow>();
  for (const ref of refs) {
    const key = `${ref.logical_session_id}\u0000${ref.platform}`;
    if (!refBySessionPlatform.has(key)) refBySessionPlatform.set(key, ref);
  }
  const workspaceNames = input.database.prepare(
    `SELECT workspace_id, display_name FROM binding_workspaces
     ORDER BY workspace_id, binding_id`,
  ).all() as unknown as WorkspaceDisplayRow[];
  const workspaceNameById = new Map<string, string>();
  for (const row of workspaceNames) {
    if (!workspaceNameById.has(row.workspace_id)) {
      workspaceNameById.set(row.workspace_id, row.display_name.trim() || row.workspace_id);
    }
  }

  const objectStore = new ZstdContentObjectStore(dirname(sourceDatabasePath));
  const prepared = await Promise.all(sessions.map(async (session) => {
    const classification = classifications.get(session.id);
    if (classification === undefined) throw new Error(`Missing canonical classification: ${session.id}`);
    const mirror = mirrorBySession.get(session.id);
    const platform = classification.disposition === "codex-mirror" ? "codex" : "dsh";
    const refVersionId = refBySessionPlatform.get(`${session.id}\u0000${platform}`)?.version_id;
    const versionId = classification.disposition === "codex-mirror"
      ? mirror?.codex_version_id ?? refVersionId ?? session.canonical_version_id
      : mirror?.dsh_version_id ?? refVersionId ?? session.canonical_version_id;
    if (versionId === null || versionId === undefined) {
      throw new Error(`Canonical migration cannot resolve the active ${platform} head: ${session.id}`);
    }
    let normalized: NormalizedSession | null = null;
    let versionCreatedAt = session.created_at;
    const version = input.database.prepare(
      "SELECT id, body_object, created_at FROM session_versions WHERE id = ? AND logical_session_id = ?",
    ).get(versionId, session.id) as ActivationVersionRow | undefined;
    if (version === undefined) throw new Error(`Canonical head version is missing: ${session.id}/${versionId}`);
    normalized = normalizedSessionSchema.parse(
      JSON.parse(Buffer.from(await objectStore.get(version.body_object)).toString("utf8")),
    ) as unknown as NormalizedSession;
    versionCreatedAt = version.created_at;
    if (classification.workspaceIds.length > 1) {
      throw new Error(`Logical session has ambiguous workspace ownership: ${session.id}`);
    }
    return { session, classification, versionId, normalized, versionCreatedAt };
  }));
  input.onStatus?.("migration.heads.loaded", {
    sessions: prepared.length,
    events: prepared.reduce((count, item) => count + (item.normalized?.events.length ?? 0), 0),
  });

  try {
    await copyFile(sourceDatabasePath, candidateDatabasePath, 1);
    await copyFile(sourceDatabasePath, archiveDatabasePath, 1);
    await chmod(archiveDatabasePath, 0o444);
    input.onStatus?.("migration.candidate.copied", { candidateDatabasePath, archiveDatabasePath });

    const candidate = openMaintenanceDatabase(candidateDatabasePath);
    try {
      candidate.exec("BEGIN IMMEDIATE");
      try {
        const insertWorkspace = candidate.prepare(
          `INSERT INTO logical_workspaces
            (id, parent_id, name, sort_key, deleted_at, created_at, updated_at)
           VALUES (?, NULL, ?, ?, NULL, ?, ?)`,
        );
        const allWorkspaceIds = [...new Set(prepared.flatMap((item) => item.classification.workspaceIds))].sort();
        const firstCreatedAt = prepared.map((item) => item.session.created_at).sort()[0] ?? new Date(0).toISOString();
        for (const [index, workspaceId] of allWorkspaceIds.entries()) {
          insertWorkspace.run(
            workspaceId,
            workspaceNameById.get(workspaceId) ?? workspaceId,
            `${String(index).padStart(8, "0")}:${workspaceId}`,
            firstCreatedAt,
            firstCreatedAt,
          );
        }

        const updateSession = candidate.prepare(
          `UPDATE logical_sessions
           SET authority_scope = ?, origin_kind = ?, head_version_id = ?,
               archived_at = ?, tombstoned_at = NULL, updated_at = ?
           WHERE id = ?`,
        );
        const insertMembership = candidate.prepare(
          `INSERT INTO workspace_memberships
            (logical_session_id, workspace_id, display_order, pinned, archived, revision)
           VALUES (?, ?, ?, 0, ?, 0)`,
        );
        const insertEvent = candidate.prepare(
          `INSERT INTO canonical_events
            (id, logical_session_id, sequence, kind, content_digest, event_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const [displayOrder, item] of prepared.entries()) {
          const authority = item.classification.disposition === "codex-mirror" ? "codex" : "maintenance";
          const origin = item.classification.disposition === "codex-mirror" ? "codex-mirror" : "maintenance-native";
          updateSession.run(
            authority,
            origin,
            item.versionId,
            item.session.archived === 1 ? item.versionCreatedAt : null,
            item.versionCreatedAt,
            item.session.id,
          );
          const metadata = { title: item.normalized!.title, archived: item.normalized!.archived };
          const storedHash = candidate.prepare("SELECT metadata_hash FROM session_versions WHERE id = ?")
            .get(item.versionId) as { readonly metadata_hash: string };
          if (sha256Canonical(metadata) === storedHash.metadata_hash) {
            saveVersionMetadataSnapshot(candidate, item.versionId, metadata, "reconstructed-body");
          }
          insertMembership.run(
            item.session.id,
            item.classification.workspaceIds[0] ?? null,
            displayOrder,
            item.session.archived,
          );
          for (const event of item.normalized?.events ?? []) {
            const canonical = canonicalEvent(item.session.id, event);
            insertEvent.run(
              canonical.id,
              item.session.id,
              canonical.sequence,
              canonical.kind,
              canonical.contentDigest,
              canonicalJson(canonical as unknown as JsonValue),
            );
          }
        }
        candidate.exec("COMMIT");
        input.onStatus?.("migration.canonical.committed", { sessions: prepared.length });
      } catch (error) {
        try { candidate.exec("ROLLBACK"); } catch { /* preserve migration error */ }
        throw error;
      }

      const integrity = candidate.prepare("PRAGMA integrity_check").all() as unknown as { readonly integrity_check: string }[];
      const foreignKeys = candidate.prepare("PRAGMA foreign_key_check").all();
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok" || foreignKeys.length !== 0) {
        throw new Error("Canonical migration candidate failed SQLite integrity validation");
      }
      const logicalSessions = databaseCount(candidate, "logical_sessions");
      const canonicalEvents = databaseCount(candidate, "canonical_events");
      const logicalWorkspaces = databaseCount(candidate, "logical_workspaces");
      const workspaceMemberships = databaseCount(candidate, "workspace_memberships");
      const expectedEvents = prepared.reduce((count, item) => count + (item.normalized?.events.length ?? 0), 0);
      if (
        logicalSessions !== preview.counts.sourceLogicalSessions ||
        canonicalEvents !== expectedEvents ||
        workspaceMemberships !== logicalSessions
      ) {
        throw new Error("Canonical migration candidate counts do not match the source preview");
      }
      input.onStatus?.("migration.integrity.verified", {
        logicalSessions,
        canonicalEvents,
        logicalWorkspaces,
        workspaceMemberships,
      });
      const schemaVersion = (candidate.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as unknown as VersionRow).version;
      candidate.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      candidate.close();

      const candidateFiles = await sourceFiles(candidateDatabasePath);
      input.onStatus?.("migration.candidate.hashed", { files: candidateFiles.length });
      return {
        sourceDatabasePath,
        candidateDatabasePath,
        archiveDatabasePath,
        sourceDigest: preview.sourceDigest,
        candidateDigest: migrationDigest(candidateFiles),
        schemaVersion,
        counts: { logicalSessions, canonicalEvents, logicalWorkspaces, workspaceMemberships },
        sourcePreserved: true,
        pointerSwitchRequired: true,
      };
    } catch (error) {
      try { candidate.close(); } catch { /* already closed */ }
      throw error;
    }
  } catch (error) {
    await rm(candidateDatabasePath, { force: true }).catch(() => undefined);
    await rm(`${candidateDatabasePath}-wal`, { force: true }).catch(() => undefined);
    await rm(`${candidateDatabasePath}-shm`, { force: true }).catch(() => undefined);
    await rm(archiveDatabasePath, { force: true }).catch(() => undefined);
    throw error;
  }
}
