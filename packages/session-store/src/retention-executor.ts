import { lstat, mkdir, rename, rmdir, unlink } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import {
  SessionMaintenanceError,
  type MaintenanceWriteEvidence,
  type MaintenanceWriteScope,
  type RetentionBatch,
  type RetentionBatchItem,
  type RetentionInventory,
  type RetentionPreviewPlan,
  type RetentionRoot,
} from "@linmu/dsh-session-contracts";
import { RetentionRepository } from "./retention-repository.js";
import { RetentionJournal } from "./retention-journal.js";
import { assertRetentionPlanCurrent, planRetention } from "./retention-policy.js";
import {
  assertStaticSqliteCompanions,
  checkedRetentionDestination,
  checkedRetentionPath,
  identifyRetentionRoot,
  inventoryRetentionTree,
  isMissing,
  retentionDigest,
} from "./retention-paths.js";

export interface RetentionExecutorOptions {
  readonly repository: RetentionRepository;
  readonly writes: MaintenanceWriteScope;
  readonly now?: () => string;
  /** Composition enables this only after every writer uses the same owner/scope protocol. */
  readonly executionEnabled?: boolean;
  /** Fault injection is only used by marked synthetic crash/recovery tests. */
  readonly fault?: (
    stage: "after-journal" | "after-quarantine-move" | "after-restore-move" | "after-unlink",
    item?: RetentionBatchItem,
  ) => void;
}

export class RetentionExecutor {
  readonly journal: RetentionJournal;
  private readonly now: () => string;
  constructor(private readonly options: RetentionExecutorOptions) {
    this.journal = new RetentionJournal(options.repository);
    this.now = options.now ?? (() => new Date().toISOString());
  }
  private get repository(): RetentionRepository {
    return this.options.repository;
  }
  private otherResources(inventory: RetentionInventory, resourceId: string): string {
    return retentionDigest(
      inventory.resources
        .filter((entry) => entry.resource.id !== resourceId)
        .map((entry) => ({
          resource: entry.resource,
          fingerprint: entry.fingerprint,
          files: entry.files,
        })),
    );
  }
  private checkOwner(): MaintenanceWriteEvidence {
    this.options.writes.assertInScope();
    if (!this.options.executionEnabled)
      throw new SessionMaintenanceError(
        "WRITE_CAPABILITY_UNAVAILABLE",
        "Storage governance execution has not been enabled by the coordinated Engine composition",
      );
    const evidence = this.options.writes.captureEvidence();
    if (
      !this.repository
        .roots()
        .some((root) => root.purpose === "state" && root.realPath === evidence.stateRoot)
    )
      throw new SessionMaintenanceError(
        "WRITE_CAPABILITY_UNAVAILABLE",
        "Write owner does not own this registered state root",
      );
    for (const source of this.repository.sources().filter((entry) => entry.retained)) {
      const root = this.repository.roots().find((entry) => entry.id === source.rootId);
      if (!root)
        throw new SessionMaintenanceError(
          "WRITE_CAPABILITY_UNAVAILABLE",
          "Source ownership is unknown",
        );
      const rel = relative(evidence.stateRoot, root.realPath);
      if (rel.startsWith("..") || isAbsolute(rel))
        throw new SessionMaintenanceError(
          "WRITE_CAPABILITY_UNAVAILABLE",
          "An external retained source is outside the exclusive writer boundary",
        );
    }
    return evidence;
  }
  private root(item: RetentionBatchItem, evidence: MaintenanceWriteEvidence): RetentionRoot {
    const root = this.repository.roots().find((entry) => entry.id === item.rootId);
    if (!root || root.purpose === "objects" || (root.purpose === "state" && !item.moves))
      throw new SessionMaintenanceError("RECOVERY_REQUIRED", "Resource root is not governed");
    const resource = this.repository.resources().find((entry) => entry.id === item.resourceId);
    if (!resource)
      throw new SessionMaintenanceError("RECOVERY_REQUIRED", "Resource registration is missing");
    this.repository.assertResourceBoundary(resource);
    const rel = relative(evidence.stateRoot, root.realPath);
    if ((!rel && !item.moves) || rel.startsWith("..") || isAbsolute(rel))
      throw new SessionMaintenanceError(
        "WRITE_CAPABILITY_UNAVAILABLE",
        "External governance roots need their own coordinated owner; they remain read-only references",
      );
    return root;
  }
  private assert(evidence: MaintenanceWriteEvidence): void {
    this.options.writes.assertEvidence(evidence);
  }
  private async exists(root: RetentionRoot, path: string): Promise<boolean> {
    try {
      await checkedRetentionPath(root, path);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
  private async sameTree(
    root: RetentionRoot,
    path: string,
    item: RetentionBatchItem,
  ): Promise<void> {
    if (item.moves) {
      await this.inspectBundle(root, item);
      return;
    }
    if (retentionDigest(await inventoryRetentionTree(root, path)) !== item.fingerprint)
      throw new SessionMaintenanceError(
        "PLAN_STALE",
        "Governed resource contents or file identity changed",
      );
  }
  private async destination(root: RetentionRoot, path: string): Promise<string> {
    const parts = path.split("/");
    parts.pop();
    for (let i = 1; i <= parts.length; i++) {
      const part = parts.slice(0, i).join("/");
      if (!(await this.exists(root, part)))
        await mkdir(await checkedRetentionDestination(root, part));
      await checkedRetentionPath(root, part);
    }
    if (await this.exists(root, path))
      throw new SessionMaintenanceError("PLAN_STALE", "Destination is already occupied");
    return checkedRetentionDestination(root, path);
  }
  private failure(batch: RetentionBatch, item: RetentionBatchItem, error: unknown): never {
    this.journal.update({
      ...batch,
      items: batch.items.map((entry) =>
        entry.resourceId === item.resourceId
          ? {
              ...entry,
              error: error instanceof SessionMaintenanceError ? error.code : "RECOVERY_REQUIRED",
            }
          : entry,
      ),
    });
    throw error instanceof SessionMaintenanceError
      ? error
      : new SessionMaintenanceError(
          "RECOVERY_REQUIRED",
          "Storage governance stopped with a durable recovery record",
          { cause: error },
        );
  }
  private async eligible(
    batch: RetentionBatch,
    item: RetentionBatchItem,
  ): Promise<RetentionInventory> {
    const inventory = await this.repository.capture(this.now()),
      plan = planRetention(inventory, batch.plan.policy);
    if (
      plan.blockers.length ||
      plan.items.find((entry) => entry.id === item.resourceId)?.disposition !== "candidate"
    )
      throw new SessionMaintenanceError(
        "PLAN_STALE",
        "Resource gained protection or recovery coverage is incomplete",
      );
    return inventory;
  }
  private async hasRegisteredCacheReplacement(
    root: RetentionRoot,
    item: RetentionBatchItem,
  ): Promise<boolean> {
    if (item.moves || !["quarantined", "purging"].includes(item.state)) return false;
    const resources = this.repository.resources();
    const previous = resources.find((entry) => entry.id === item.resourceId);
    const replacement = resources.find(
      (entry) =>
        entry.id !== item.resourceId &&
        entry.rootId === item.rootId &&
        entry.relativePath === item.originalPath &&
        entry.state === "registered" &&
        entry.kind === "cache" &&
        entry.ownerId === previous?.ownerId,
    );
    if (previous?.kind !== "cache" || !replacement) return false;
    const current = await identifyRetentionRoot(
      replacement.id,
      await checkedRetentionPath(root, item.originalPath),
      root.purpose,
    );
    const expectedId = `resource_${retentionDigest({
      root: root.id,
      path: item.originalPath,
      ownerId: replacement.ownerId,
      identity: current.identity,
    }).slice(7, 31)}`;
    const isolated = await identifyRetentionRoot(
      item.resourceId,
      await checkedRetentionPath(root, item.quarantinePath),
      root.purpose,
    );
    return (
      replacement.id === expectedId &&
      current.identity !== isolated.identity &&
      item.files.find((file) => file.relativePath === "")?.identity === `${isolated.identity}:d`
    );
  }

  private async reconcile(
    batch: RetentionBatch,
    evidence: MaintenanceWriteEvidence,
    allowRegisteredCacheReplacement = false,
  ): Promise<RetentionBatch> {
    for (const item of batch.items) {
      if (!["planned", "quarantined"].includes(item.state)) continue;
      if (item.moves) {
        const next = await this.inspectBundle(this.root(item, evidence), item);
        this.assert(evidence);
        batch = this.saveItem(batch, next);
        if (next.state === "planned" && next.moves!.every((move) => move.state === "quarantined"))
          batch = this.journal.transition(batch, next, "quarantined");
        else if (
          next.state === "quarantined" &&
          next.moves!.every((move) => move.state === "restored")
        )
          batch = this.journal.transition(batch, next, "restored");
        continue;
      }
      const root = this.root(item, evidence),
        original = await this.exists(root, item.originalPath),
        quarantined = await this.exists(root, item.quarantinePath);
      if (original && quarantined) {
        if (
          allowRegisteredCacheReplacement &&
          (await this.hasRegisteredCacheReplacement(root, item))
        ) {
          await this.sameTree(root, item.quarantinePath, item);
          continue;
        }
        throw new SessionMaintenanceError(
          "PLAN_STALE",
          "Both original and quarantine locations exist; recovery will not overwrite either",
        );
      }
      if (!original && !quarantined)
        throw new SessionMaintenanceError(
          "RECOVERY_REQUIRED",
          "Both governed resource locations are missing",
        );
      this.assert(evidence);
      if (item.state === "planned" && quarantined) {
        await this.sameTree(root, item.quarantinePath, item);
        batch = this.journal.transition(batch, item, "quarantined");
      } else if (item.state === "quarantined" && original) {
        await this.sameTree(root, item.originalPath, item);
        batch = this.journal.transition(batch, item, "restored");
      }
    }
    return batch;
  }

  private saveItem(batch: RetentionBatch, item: RetentionBatchItem): RetentionBatch {
    const next = {
      ...batch,
      items: batch.items.map((entry) => (entry.resourceId === item.resourceId ? item : entry)),
    };
    this.journal.update(next);
    return next;
  }
  private async inspectBundle(
    root: RetentionRoot,
    item: RetentionBatchItem,
  ): Promise<RetentionBatchItem> {
    const moves: NonNullable<RetentionBatchItem["moves"]>[number][] = [];
    await assertStaticSqliteCompanions(
      root,
      item.originalPath,
      item.moves!.map((move) => move.originalPath),
    );
    if (await this.exists(root, item.quarantinePath)) {
      const tree = await inventoryRetentionTree(root, item.quarantinePath),
        directory = tree[0];
      if (
        !item.quarantineDirectoryIdentity ||
        directory?.identity !== item.quarantineDirectoryIdentity ||
        tree
          .slice(1)
          .some(
            (file) => !item.files.some((expected) => expected.relativePath === file.relativePath),
          )
      )
        throw new SessionMaintenanceError(
          "PLAN_STALE",
          "SQLite quarantine directory changed or contains unknown files",
        );
    }
    for (const move of item.moves!) {
      const original = await this.exists(root, move.originalPath),
        quarantined = await this.exists(root, move.quarantinePath);
      if (original === quarantined)
        throw new SessionMaintenanceError(
          "RECOVERY_REQUIRED",
          "SQLite bundle member has ambiguous or missing locations",
        );
      const tree = await inventoryRetentionTree(
          root,
          original ? move.originalPath : move.quarantinePath,
        ),
        file = tree[0],
        expected = item.files.find((entry) => entry.relativePath === basename(move.originalPath));
      if (
        !file ||
        !expected ||
        tree.length !== 1 ||
        file.identity !== expected.identity ||
        file.bytes !== expected.bytes ||
        file.mtimeMs !== expected.mtimeMs
      )
        throw new SessionMaintenanceError("PLAN_STALE", "SQLite bundle member identity changed");
      moves.push({
        ...move,
        state: quarantined ? "quarantined" : item.state === "planned" ? "planned" : "restored",
      });
    }
    return { ...item, moves };
  }
  private guard(
    inventory: RetentionInventory,
    item: RetentionBatchItem,
  ): NonNullable<RetentionBatchItem["purgeGuard"]> {
    const excludedSourceIds = inventory.sources
      .filter(
        (source) =>
          source.rootId === item.rootId &&
          (source.relativePath.startsWith(`${item.quarantinePath}/`) ||
            item.moves?.some(
              (move) =>
                source.relativePath === move.originalPath ||
                source.relativePath === move.quarantinePath,
            )),
      )
      .map((source) => source.id);
    return {
      sourceRevisions: Object.fromEntries(
        Object.entries(inventory.sourceRevisions).filter(
          ([source]) => !excludedSourceIds.includes(source),
        ),
      ),
      excludedSourceIds,
      registryFingerprint: inventory.registryFingerprint,
      otherResourceFingerprint: this.otherResources(inventory, item.resourceId),
    };
  }
  private async assertGuard(
    item: RetentionBatchItem,
    guard: NonNullable<RetentionBatchItem["purgeGuard"]>,
  ): Promise<void> {
    const inventory = await this.repository.capture(this.now());
    if (
      inventory.blockers.some(
        (blocker) =>
          blocker.source !== item.resourceId && !guard.excludedSourceIds.includes(blocker.source),
      ) ||
      retentionDigest(
        Object.fromEntries(
          Object.entries(inventory.sourceRevisions).filter(
            ([source]) => !guard.excludedSourceIds.includes(source),
          ),
        ),
      ) !== retentionDigest(guard.sourceRevisions) ||
      inventory.registryFingerprint !== guard.registryFingerprint ||
      this.otherResources(inventory, item.resourceId) !== guard.otherResourceFingerprint
    )
      throw new SessionMaintenanceError(
        "PLAN_STALE",
        "References changed during an interrupted multi-file operation",
      );
  }

  async quarantine(plan: RetentionPreviewPlan): Promise<RetentionBatch> {
    return this.options.writes.run("retention-execution", async () => {
      const evidence = this.checkOwner();
      let batch = this.journal.get(plan.id);
      if (!batch) {
        const inventory = await this.repository.capture(plan.asOf);
        assertRetentionPlanCurrent(plan, inventory);
        const createdAt = this.now();
        if (Date.parse(createdAt) < Date.parse(plan.asOf))
          throw new SessionMaintenanceError(
            "PLAN_STALE",
            "Local clock moved before the preview instant",
          );
        const id = `retention_${plan.id.slice(7, 39)}`;
        const byId = new Map(inventory.resources.map((entry) => [entry.resource.id, entry]));
        const items: RetentionBatchItem[] = plan.items
          .filter((entry) => entry.executable)
          .map((entry) => {
            const resource = byId.get(entry.id);
            if (!resource || entry.kind === "content-object")
              throw new Error("Only registered directory resources can execute");
            const quarantinePath = `.retention-quarantine/${id}/${retentionDigest(entry.id).slice(7, 31)}`;
            return {
              resourceId: entry.id,
              rootId: entry.rootId,
              originalPath: entry.relativePath,
              quarantinePath,
              fingerprint: resource.fingerprint,
              bytes: resource.bytes,
              files: resource.files,
              state: "planned",
              error: null,
              purgeGuard: null,
              ...(resource.resource.sqliteBundle
                ? {
                    moves: resource.resource.sqliteBundle.map((member) => ({
                      originalPath: member,
                      quarantinePath: `${quarantinePath}/${basename(member)}`,
                      state: "planned" as const,
                    })),
                  }
                : {}),
            };
          });
        for (const item of items) this.root(item, evidence);
        batch = {
          schemaVersion: 1,
          id,
          plan,
          createdAt,
          purgeAfter: new Date(
            Date.parse(createdAt) + plan.policy.quarantineHours * 3600000,
          ).toISOString(),
          items,
        };
        this.assert(evidence);
        this.journal.create(batch);
        this.options.fault?.("after-journal");
      }
      batch = await this.reconcile(batch, evidence);
      for (const originalItem of batch.items) {
        let item = batch.items.find((entry) => entry.resourceId === originalItem.resourceId)!;
        if (item.state !== "planned") continue;
        try {
          if (item.moves) {
            const root = this.root(item, evidence);
            if (!item.quarantineGuard) {
              const inventory = await this.eligible(batch, item);
              item = { ...item, quarantineGuard: this.guard(inventory, item) };
              batch = this.saveItem(batch, item);
            } else await this.assertGuard(item, item.quarantineGuard);
            if (!item.quarantineDirectoryIdentity) {
              const target = await this.destination(root, item.quarantinePath);
              this.assert(evidence);
              await mkdir(target);
              item = {
                ...item,
                quarantineDirectoryIdentity: (
                  await inventoryRetentionTree(root, item.quarantinePath)
                )[0]!.identity,
              };
              batch = this.saveItem(batch, item);
            }
            item = await this.inspectBundle(root, item);
            for (const move of item.moves!)
              if (move.state === "planned") {
                const target = await this.destination(root, move.quarantinePath),
                  source = await checkedRetentionPath(root, move.originalPath);
                this.assert(evidence);
                await rename(source, target);
                this.options.fault?.("after-quarantine-move", item);
                item = {
                  ...item,
                  moves: item.moves!.map((entry) =>
                    entry.originalPath === move.originalPath
                      ? { ...entry, state: "quarantined" as const }
                      : entry,
                  ),
                };
                batch = this.saveItem(batch, item);
              }
            await this.inspectBundle(root, item);
            this.assert(evidence);
            batch = this.journal.transition(batch, item, "quarantined");
            continue;
          }
          await this.eligible(batch, item);
          const root = this.root(item, evidence);
          await this.sameTree(root, item.originalPath, item);
          const target = await this.destination(root, item.quarantinePath),
            source = await checkedRetentionPath(root, item.originalPath);
          this.assert(evidence);
          await rename(source, target);
          this.options.fault?.("after-quarantine-move", item);
          await this.sameTree(root, item.quarantinePath, item);
          this.assert(evidence);
          batch = this.journal.transition(batch, item, "quarantined");
        } catch (error) {
          this.failure(batch, item, error);
        }
      }
      return batch;
    });
  }

  async restore(id: string): Promise<RetentionBatch> {
    return this.options.writes.run("retention-restore", async () => {
      const evidence = this.checkOwner();
      let batch = this.journal.get(id);
      if (!batch)
        throw new SessionMaintenanceError(
          "TRANSACTION_NOT_FOUND",
          "Storage governance batch was not found",
        );
      batch = await this.reconcile(batch, evidence);
      // Positive restoration may resolve an unrelated coverage blocker. It still captures current refs,
      // validates path identities and refuses every existing destination; no unique data is deleted.
      await this.repository.capture(this.now());
      for (const originalItem of batch.items) {
        let item = batch.items.find((entry) => entry.resourceId === originalItem.resourceId)!;
        if (item.state === "restored") continue;
        if (item.state === "purging" || item.state === "purged")
          throw new SessionMaintenanceError(
            "TRANSACTION_NOT_RESTORABLE",
            "This resource has entered final release",
          );
        try {
          const root = this.root(item, evidence);
          if (item.moves) {
            item = await this.inspectBundle(root, item);
            for (const move of item.moves!)
              if (move.state === "quarantined") {
                const target = await this.destination(root, move.originalPath),
                  source = await checkedRetentionPath(root, move.quarantinePath);
                this.assert(evidence);
                await rename(source, target);
                this.options.fault?.("after-restore-move", item);
                item = {
                  ...item,
                  moves: item.moves!.map((entry) =>
                    entry.originalPath === move.originalPath
                      ? { ...entry, state: "restored" as const }
                      : entry,
                  ),
                };
                batch = this.saveItem(batch, item);
              }
            this.assert(evidence);
            batch = this.journal.transition(batch, item, "restored");
            continue;
          }
          if (item.state === "planned") {
            await this.sameTree(root, item.originalPath, item);
            this.assert(evidence);
            batch = this.journal.transition(batch, item, "restored");
            continue;
          }
          await this.sameTree(root, item.quarantinePath, item);
          const target = await this.destination(root, item.originalPath),
            source = await checkedRetentionPath(root, item.quarantinePath);
          this.assert(evidence);
          await rename(source, target);
          this.options.fault?.("after-restore-move", item);
          await this.sameTree(root, item.originalPath, item);
          this.assert(evidence);
          batch = this.journal.transition(batch, item, "restored");
        } catch (error) {
          this.failure(batch, item, error);
        }
      }
      return batch;
    });
  }

  async purge(id: string): Promise<RetentionBatch> {
    return this.options.writes.run("retention-purge", async () => {
      const evidence = this.checkOwner();
      let batch = this.journal.get(id);
      if (!batch)
        throw new SessionMaintenanceError(
          "TRANSACTION_NOT_FOUND",
          "Storage governance batch was not found",
        );
      if (Date.parse(this.now()) < Date.parse(batch.purgeAfter))
        throw new SessionMaintenanceError(
          "CONFIRMATION_REQUIRED",
          "The quarantine recovery grace period has not elapsed",
        );
      batch = await this.reconcile(batch, evidence, true);
      for (const originalItem of batch.items) {
        let item = batch.items.find((entry) => entry.resourceId === originalItem.resourceId)!;
        if (item.state === "restored" || item.state === "purged") continue;
        if (item.state === "planned")
          throw new SessionMaintenanceError(
            "RECOVERY_REQUIRED",
            "Quarantine must finish before final release",
          );
        try {
          const root = this.root(item, evidence);
          if (
            (await this.exists(root, item.originalPath)) &&
            !(await this.hasRegisteredCacheReplacement(root, item))
          )
            throw new SessionMaintenanceError("PLAN_STALE", "Original resource path was reused");
          if (item.state !== "purging") {
            const inventory = await this.eligible(batch, item);
            await this.sameTree(root, item.quarantinePath, item);
            const excludedSourceIds = inventory.sources
              .filter(
                (source) =>
                  source.rootId === item.rootId &&
                  source.relativePath.startsWith(`${item.quarantinePath}/`),
              )
              .map((source) => source.id);
            item = {
              ...item,
              state: "purging",
              purgeGuard: {
                sourceRevisions: Object.fromEntries(
                  Object.entries(inventory.sourceRevisions).filter(
                    ([source]) => !excludedSourceIds.includes(source),
                  ),
                ),
                excludedSourceIds,
                registryFingerprint: inventory.registryFingerprint,
                otherResourceFingerprint: this.otherResources(inventory, item.resourceId),
              },
            };
            batch = {
              ...batch,
              items: batch.items.map((entry) =>
                entry.resourceId === item.resourceId ? item : entry,
              ),
            };
            this.assert(evidence);
            this.journal.update(batch);
          } else {
            const inventory = await this.repository.capture(this.now()),
              guard = item.purgeGuard;
            if (
              !guard ||
              inventory.blockers.some(
                (blocker) =>
                  blocker.source !== item.resourceId &&
                  !guard.excludedSourceIds.includes(blocker.source),
              ) ||
              retentionDigest(
                Object.fromEntries(
                  Object.entries(inventory.sourceRevisions).filter(
                    ([source]) => !guard.excludedSourceIds.includes(source),
                  ),
                ),
              ) !== retentionDigest(guard.sourceRevisions) ||
              inventory.registryFingerprint !== guard.registryFingerprint ||
              this.otherResources(inventory, item.resourceId) !== guard.otherResourceFingerprint
            )
              throw new SessionMaintenanceError(
                "PLAN_STALE",
                "References changed during an interrupted final release; manual recovery review is required",
              );
          }
          // A known manifest of exact files is reused after a crash. New entries are never recursively removed.
          let remaining: Awaited<ReturnType<typeof inventoryRetentionTree>> = [];
          if (await this.exists(root, item.quarantinePath))
            remaining = await inventoryRetentionTree(root, item.quarantinePath);
          const expected = new Map(item.files.map((file) => [file.relativePath, file]));
          if (item.moves && item.quarantineDirectoryIdentity)
            expected.set("", {
              relativePath: "",
              identity: item.quarantineDirectoryIdentity,
              bytes: 0,
              mtimeMs: 0,
            });
          for (const file of remaining) {
            const old = expected.get(file.relativePath);
            if (
              !old ||
              old.identity !== file.identity ||
              old.bytes !== file.bytes ||
              (file.identity.endsWith(":f") && old.mtimeMs !== file.mtimeMs)
            )
              throw new SessionMaintenanceError(
                "PLAN_STALE",
                "Quarantined files changed during final release",
              );
          }
          for (const file of [...remaining].sort(
            (a, b) =>
              b.relativePath.split("/").length - a.relativePath.split("/").length ||
              b.relativePath.localeCompare(a.relativePath),
          )) {
            const path = file.relativePath
              ? `${item.quarantinePath}/${file.relativePath}`
              : item.quarantinePath;
            const target = await checkedRetentionPath(root, path),
              info = await lstat(target, { bigint: true });
            const identity = `${info.dev}:${info.ino}:${info.birthtimeNs}:${info.isDirectory() ? "d" : "f"}`;
            if (identity !== file.identity)
              throw new SessionMaintenanceError(
                "PLAN_STALE",
                "File identity changed immediately before release",
              );
            this.assert(evidence);
            if (info.isDirectory()) await rmdir(target);
            else await unlink(target);
            this.options.fault?.("after-unlink", item);
          }
          this.assert(evidence);
          batch = this.journal.transition(batch, item, "purged");
        } catch (error) {
          this.failure(batch, item, error);
        }
      }
      return batch;
    });
  }
}
