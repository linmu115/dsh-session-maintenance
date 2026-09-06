import { resolve } from "node:path";
import {
  persistentProjectionCacheManifestV1Schema,
  projectionOperationReceiptSchema,
  type RetentionBlocker,
  type RetentionReference,
  type RetentionResource,
  type RetentionResourceInventory,
  type RetentionRoot,
  type RetentionSource,
} from "@linmu/dsh-session-contracts";
import {
  inventoryRetentionResource,
  readRetentionJson,
  retentionDigest,
} from "./retention-paths.js";
import {
  retentionJson,
  retentionRecord,
  retentionString,
  type RetentionRows,
} from "./retention-repository.js";

/** Evidence parsing only: never deletes or interprets an unknown directory name as a completed run. */
export async function captureRetentionResources(
  roots: ReadonlyMap<string, RetentionRoot>,
  registered: readonly RetentionResource[],
  sources: readonly RetentionSource[],
  rows: RetentionRows,
  references: RetentionReference[],
  blockers: RetentionBlocker[],
): Promise<readonly RetentionResourceInventory[]> {
  const result: RetentionResourceInventory[] = [];
  const runs = rows.projection_runs ?? [],
    operations = rows.run_operations ?? [];
  const cachesInUse = new Set<string>();
  const block = (resource: RetentionResource, detail: string): void => {
    blockers.push({ code: "inconsistent-evidence", source: resource.id, detail });
  };
  for (const run of runs)
    if (
      !["closed", "recovered"].includes(String(run.state)) &&
      !registered.some(
        (resource) =>
          resource.kind === "run" && resource.ownerId === run.id && resource.state !== "purged",
      )
    ) {
      blockers.push({
        code: "unregistered",
        source: String(run.id),
        detail: "Active or unresolved run has no registered WAL/recovery directory",
      });
    }
  // Read run evidence before caches so every retained sparse overlay protects its base.
  const ordered = [...registered].sort(
    (a, b) => (a.kind === "run" ? 0 : 1) - (b.kind === "run" ? 0 : 1) || a.id.localeCompare(b.id),
  );
  for (const resource of ordered) {
    if (resource.state === "purged") continue;
    const root = roots.get(resource.rootId),
      reasons: string[] = [];
    let completedAt: string | null = null,
      recoveryCompleted = false,
      valid = true;
    let files: RetentionResourceInventory["files"] = [],
      fingerprint = retentionDigest([]);
    try {
      if (!root) throw new Error("Missing registered root");
      files = await inventoryRetentionResource(root, resource);
      fingerprint = retentionDigest(files);
      if (resource.pinned) reasons.push("manually-pinned");
      if (resource.recoveryRequired) reasons.push("registered-recovery-dependency");
      if (resource.kind === "run") {
        const run = runs.find((entry) => entry.id === resource.ownerId);
        if (!run) {
          block(resource, "Run identity is absent from the active database");
          valid = false;
        } else {
          const finished = ["closed", "recovered"].includes(String(run.state));
          recoveryCompleted = run.state === "recovered";
          if (!finished) reasons.push(`run-${String(run.state)}`);
          const checkpoint = (rows.checkpoints ?? []).find(
            (entry) => entry.id === run.checkpoint_id,
          );
          if (finished) {
            const refs = checkpoint ? retentionRecord(retentionJson(checkpoint.refs_json)) : {};
            if (
              checkpoint?.created_by !== "projection-lifecycle" ||
              refs.run !== run.id ||
              typeof refs.catalog !== "string"
            ) {
              reasons.push("close-checkpoint-unproven");
              valid = false;
            } else completedAt = retentionString(checkpoint.created_at);
          }
          const recovery = retentionRecord(
            await readRetentionJson(root, `${resource.relativePath}/recovery.json`),
          );
          if (
            recovery.schemaVersion !== 1 ||
            recovery.runId !== run.id ||
            typeof recovery.maintenanceEndpoint !== "string"
          )
            throw new Error("Recovery descriptor identity mismatch");
          let base: string | null = retentionString(recovery.baseProjectionRoot);
          if (files.some((file) => file.relativePath === "projection/base-projection.json")) {
            const overlay = retentionRecord(
              await readRetentionJson(
                root,
                `${resource.relativePath}/projection/base-projection.json`,
              ),
            );
            if (
              overlay.schemaVersion !== 1 ||
              typeof overlay.root !== "string" ||
              (base !== null && resolve(base) !== resolve(overlay.root))
            )
              throw new Error("Sparse overlay and recovery base disagree");
            base = overlay.root;
          }
          if (base !== null) {
            const cache = registered.find(
              (entry) =>
                entry.kind === "cache" &&
                entry.state !== "purged" &&
                roots.has(entry.rootId) &&
                resolve(roots.get(entry.rootId)!.path, entry.relativePath) === resolve(base),
            );
            if (!cache) {
              block(resource, "Run references an unregistered cache base");
              valid = false;
            } else {
              cachesInUse.add(cache.id);
              references.push({
                source: "runtime",
                owner: resource.id,
                targetKind: "cache",
                targetId: cache.ownerId,
                objectRootId: null,
                reason: "retained-run-sparse-base",
              });
            }
          }
          const walIds = new Set<string>();
          for (const file of files.filter(
            (entry) => entry.relativePath.startsWith("wal/") && entry.bytes > 0,
          )) {
            if (!/^wal\/[^/]+\.json$/u.test(file.relativePath)) {
              block(
                resource,
                "WAL has pending, superseded or unknown evidence that needs explicit recovery resolution",
              );
              valid = false;
              continue;
            }
            const wal = retentionRecord(
              await readRetentionJson(root, `${resource.relativePath}/${file.relativePath}`),
            );
            const operation = retentionRecord(wal.operation),
              id = retentionString(operation.operationId);
            if (wal.schemaVersion !== 1 || !id || operation.runId !== run.id || walIds.has(id))
              throw new Error("WAL operation identity mismatch");
            walIds.add(id);
            const receipt = operations.find(
              (entry) => entry.operation_id === id && entry.run_id === run.id,
            );
            if (wal.state !== "committed" || wal.projectionApplied !== true)
              reasons.push("uncommitted-wal");
            else {
              const decoded = projectionOperationReceiptSchema.parse(wal.receipt);
              if (
                !receipt ||
                receipt.status !== "committed" ||
                retentionDigest(decoded) !== retentionDigest(retentionJson(receipt.receipt_json))
              ) {
                block(resource, "WAL and database receipt disagree");
                valid = false;
              }
              if (decoded.canonicalVersionId)
                references.push({
                  source: "wal",
                  owner: id,
                  targetKind: "version-body",
                  targetId: decoded.canonicalVersionId,
                  objectRootId: null,
                  reason: "committed-wal-receipt",
                });
            }
          }
          for (const operation of operations.filter((entry) => entry.run_id === run.id)) {
            if (operation.status !== "committed") reasons.push("unfinished-operation");
            if (!walIds.has(String(operation.operation_id))) {
              block(resource, "Database operation has no matching retained WAL record");
              valid = false;
            }
          }
          // Other checkpoint kinds may explicitly require the run directory for restore.
          if (
            references.some(
              (ref) =>
                ref.targetKind === "run" &&
                ref.targetId === run.id &&
                ref.reason !== "projection-close-checkpoint-metadata",
            )
          )
            reasons.push("checkpoint-run-dependency");
        }
      } else if (resource.kind === "cache") {
        const manifest = persistentProjectionCacheManifestV1Schema.parse(
          await readRetentionJson(root, `${resource.relativePath}/projection-cache-manifest.json`),
        );
        if (manifest.cacheKey !== resource.ownerId) throw new Error("Cache identity mismatch");
        if (cachesInUse.has(resource.id)) reasons.push("retained-run-sparse-base");
        for (const session of manifest.sessions)
          if (session.canonicalHeadVersionId)
            references.push({
              source: "cache",
              owner: resource.id,
              targetKind: "version-body",
              targetId: session.canonicalHeadVersionId,
              objectRootId: null,
              reason: "cache-canonical-base",
            });
        if (resource.lastUsedAt === null) reasons.push("cache-last-use-unknown");
      } else {
        if (resource.verifiedAt === null || resource.verifiedFingerprint !== fingerprint) {
          reasons.push("backup-validity-unproven");
          valid = false;
        }
        if (resource.kind === "backup") {
          const transaction = (rows.transactions ?? []).find(
            (entry) => entry.id === resource.ownerId,
          );
          if (!transaction || !["completed", "restored"].includes(String(transaction.status)))
            reasons.push("transaction-not-verifiably-finished");
          else completedAt = retentionString(transaction.updated_at);
          if (
            references.some(
              (ref) => ref.targetKind === "backup" && ref.targetId === resource.ownerId,
            )
          )
            reasons.push("checkpoint-or-recovery-backup");
        } else {
          const source = sources.find((entry) => entry.id === resource.ownerId);
          if (!source || source.kind === "active-database" || !source.retained) {
            reasons.push("candidate-registration-unproven");
            valid = false;
          }
          // Candidate validity is certified by a deliberate read-only verify action, using local verify time.
          completedAt = resource.verifiedAt;
        }
      }
    } catch {
      block(resource, "Resource path, identity or recovery evidence cannot be verified");
      valid = false;
    }
    result.push({
      resource,
      fingerprint,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      files,
      reasons: [...new Set(reasons)].sort(),
      completedAt,
      recoveryCompleted,
      valid,
    });
  }
  return result.sort((a, b) => a.resource.id.localeCompare(b.resource.id));
}
