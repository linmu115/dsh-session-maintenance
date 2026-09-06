/** Storage governance deliberately keeps every existing version body (SM-10 is separate). */
export interface RetentionRoot {
  readonly id: string;
  readonly path: string;
  readonly realPath: string;
  readonly identity: string;
  readonly purpose: "state" | "objects" | "runs" | "caches" | "backups" | "databases";
}

export interface RetentionSource {
  readonly id: string;
  readonly rootId: string;
  readonly relativePath: string;
  readonly objectRootId: string;
  readonly kind: "active-database" | "backup-database" | "candidate-database" | "unknown";
  readonly retained: boolean;
}

export type RetentionResourceKind = "run" | "cache" | "backup" | "candidate";
export interface RetentionResource {
  readonly id: string;
  readonly rootId: string;
  readonly relativePath: string;
  readonly kind: RetentionResourceKind;
  /** Run ID, cache key, transaction ID, or registered source ID. */
  readonly ownerId: string;
  readonly group: string;
  readonly pinned: boolean;
  readonly recoveryRequired: boolean;
  readonly verifiedAt: string | null;
  readonly verifiedFingerprint: string | null;
  readonly lastUsedAt: string | null;
  readonly state: "registered" | "quarantined" | "purged";
}

export interface RetentionBlocker {
  readonly code: "unregistered" | "unreadable" | "unknown-format" | "unsafe-path" | "missing-reference" | "inconsistent-evidence" | "coordination-unproven";
  readonly source: string;
  readonly detail: string;
}

export interface RetentionReference {
  readonly source: string;
  readonly owner: string;
  readonly targetKind: "version-metadata" | "version-body" | "content-object" | "run" | "cache" | "backup";
  readonly targetId: string;
  readonly objectRootId: string | null;
  readonly reason: string;
}

export interface RetentionVersion {
  readonly source: string;
  readonly id: string;
  readonly objectId: string;
  readonly objectRootId: string;
  readonly parents: readonly string[];
  readonly firstPersistedAt: string | null;
}

export interface RetentionFile {
  readonly relativePath: string;
  readonly identity: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

export interface RetentionObject extends RetentionFile {
  readonly rootId: string;
  readonly objectId: string;
}

export interface RetentionResourceInventory {
  readonly resource: RetentionResource;
  readonly fingerprint: string;
  readonly bytes: number;
  readonly files: readonly RetentionFile[];
  readonly reasons: readonly string[];
  readonly completedAt: string | null;
  readonly recoveryCompleted: boolean;
  readonly valid: boolean;
}

export interface RetentionInventory {
  readonly schemaVersion: 1;
  readonly asOf: string;
  readonly roots: readonly RetentionRoot[];
  readonly sources: readonly RetentionSource[];
  readonly sourceRevisions: Readonly<Record<string, string>>;
  readonly versions: readonly RetentionVersion[];
  readonly references: readonly RetentionReference[];
  readonly objects: readonly RetentionObject[];
  readonly resources: readonly RetentionResourceInventory[];
  readonly blockers: readonly RetentionBlocker[];
  readonly registryFingerprint: string;
  readonly referenceFingerprint: string;
  readonly objectFingerprint: string;
  readonly resourceFingerprint: string;
}

export interface RetentionPolicy {
  readonly schemaVersion: 1;
  readonly history: "protect-all-version-bodies";
  readonly finishedRunHours: number;
  readonly recoveredRunHours: number;
  readonly automaticBackupsToKeep: number;
  readonly cacheTargetBytes: number;
  readonly quarantineHours: number;
  readonly orphanGraceHours: number;
}

export interface RetentionPlanItem {
  readonly id: string;
  readonly kind: "content-object" | RetentionResourceKind;
  readonly rootId: string;
  readonly relativePath: string;
  readonly bytes: number;
  readonly disposition: "protected" | "candidate" | "blocked";
  readonly reasons: readonly string[];
  readonly references: readonly RetentionReference[];
  /** Content objects are preview-only in SM-08/09. */
  readonly executable: boolean;
}

export interface RetentionPreviewPlan {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly asOf: string;
  readonly policy: RetentionPolicy;
  readonly sourceRevisions: Readonly<Record<string, string>>;
  readonly registryFingerprint: string;
  readonly referenceFingerprint: string;
  readonly objectFingerprint: string;
  readonly resourceFingerprint: string;
  readonly blockers: readonly RetentionBlocker[];
  readonly items: readonly RetentionPlanItem[];
  readonly protectedBytes: number;
  readonly candidateBytes: number;
  readonly executableBytes: number;
  readonly cacheBytesAboveTarget: number;
}

export interface RetentionBatchItem {
  readonly resourceId: string;
  readonly rootId: string;
  readonly originalPath: string;
  readonly quarantinePath: string;
  readonly fingerprint: string;
  readonly bytes: number;
  readonly files: readonly RetentionFile[];
  readonly state: "planned" | "quarantined" | "restored" | "purging" | "purged";
  readonly error: string | null;
  readonly purgeGuard: {
    readonly sourceRevisions: Readonly<Record<string,string>>;
    readonly excludedSourceIds: readonly string[];
    readonly registryFingerprint: string;
    readonly otherResourceFingerprint: string;
  } | null;
}

export interface RetentionBatch {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly plan: RetentionPreviewPlan;
  readonly createdAt: string;
  readonly purgeAfter: string;
  readonly items: readonly RetentionBatchItem[];
}

export interface RetentionDiscoveryResult {
  readonly registeredResourceIds: readonly string[];
  readonly unknownPaths: readonly string[];
}
export interface RetentionRegistry {
  readonly roots: readonly RetentionRoot[];
  readonly sources: readonly RetentionSource[];
  readonly resources: readonly RetentionResource[];
}
