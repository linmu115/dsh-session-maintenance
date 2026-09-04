import { z } from "zod";

import type { JsonValue } from "./model.js";
import { STATUS_STAGES } from "./status.js";

const idSchema = z.string().min(1);
const timestampSchema = z.string().datetime({ offset: true });
const nonNegativeIntegerSchema = z.number().int().nonnegative();

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const platformKindSchema = z.enum(["codex", "dsh"]);
export const syncModeSchema = z.enum(["continuation", "native-mirror", "paused"]);
export const nativeMirrorStateSchema = z.enum([
  "disabled", "initializing", "active", "paused", "busy", "incompatible", "conflicted", "recovering",
]);
export const compatibilityStatusSchema = z.enum(["compatible", "degraded", "unsupported"]);
export const bindingStatusSchema = z.enum(["read-only", "writable", "busy", "incompatible"]);
export const sessionStatusSchema = z.enum([
  "unmapped",
  "equal",
  "source-ahead",
  "target-ahead",
  "diverged",
  "rewritten",
  "conflict",
  "paused",
  "unsupported",
]);

export const authorityScopeSchema = z.enum(["codex", "maintenance"]);
export const sessionOriginKindSchema = z.enum([
  "codex-mirror",
  "maintenance-native",
  "codex-derived",
]);
export const sessionDerivationKindSchema = z.literal("dsh-continuation");

export const canonicalEventKindSchema = z.enum([
  "user-message",
  "assistant-message",
  "system-message",
  "reasoning",
  "tool-call",
  "tool-result",
  "annotation",
  "sticker",
  "obsidian-reference",
  "attachment",
  "system-metadata",
  "other",
  "opaque-unknown",
]);
export const canonicalOtherReasonSchema = z.enum([
  "no-common-semantics",
  "unsupported-source-event",
  "orphan-tool-result",
  "adapter-evidence",
]);
export const canonicalOtherContentV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  type: z.literal("other"),
  reason: canonicalOtherReasonSchema,
  sourceKind: z.string().min(1),
  label: z.string().min(1),
  summary: z.string().min(1),
  evidenceRef: z.string().min(1).nullable(),
});
export const adapterEvidenceInputV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  adapterId: idSchema,
  nativeFormatId: z.string().min(1),
  sourceKind: z.string().min(1),
  payload: jsonValueSchema,
  observedAt: timestampSchema,
});
export const adapterEvidenceRecordV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  ref: z.string().regex(/^evidence:sha256:[0-9a-f]{64}$/u),
  adapterId: idSchema,
  nativeFormatId: z.string().min(1),
  sourceKind: z.string().min(1),
  objectId: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  byteLength: nonNegativeIntegerSchema,
  createdAt: timestampSchema,
});
export const canonicalEventRoleSchema = z.enum([
  "user",
  "assistant",
  "system",
  "tool",
  "unknown",
]);
export const canonicalEventSourceSchema = z.strictObject({
  platform: platformKindSchema,
  instanceId: idSchema,
  sessionId: idSchema,
  eventId: idSchema.nullable(),
  cursor: z.string().nullable(),
});
export const canonicalEventV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  id: idSchema,
  logicalSessionId: idSchema,
  sequence: nonNegativeIntegerSchema,
  kind: canonicalEventKindSchema,
  role: canonicalEventRoleSchema,
  content: jsonValueSchema,
  source: canonicalEventSourceSchema,
  contentDigest: idSchema,
  rawPayload: jsonValueSchema.nullable(),
  extensions: z.record(z.string(), jsonValueSchema),
}).superRefine((event, context) => {
  if (event.kind !== "other") return;
  if (event.role !== "unknown") {
    context.addIssue({
      code: "custom",
      path: ["role"],
      message: "MCSF other events must use the unknown role",
    });
  }
  if (event.rawPayload !== null) {
    context.addIssue({
      code: "custom",
      path: ["rawPayload"],
      message: "MCSF other events must keep Adapter evidence outside the public event",
    });
  }
  const parsed = canonicalOtherContentV1Schema.safeParse(event.content);
  if (!parsed.success) {
    context.addIssue({
      code: "custom",
      path: ["content"],
      message: "MCSF other events require CanonicalOtherContentV1",
    });
  }
});
export const canonicalSessionRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: idSchema,
  authorityScope: authorityScopeSchema,
  originKind: sessionOriginKindSchema,
  headVersionId: idSchema.nullable(),
  title: z.string(),
  tags: z.array(z.string()),
  archivedAt: timestampSchema.nullable(),
  tombstonedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export const nativeSessionReferenceUseSchema = z.enum(["source", "active-projection", "historical-alias"]);
export const nativeSessionReferenceV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  logicalSessionId: idSchema,
  platform: platformKindSchema,
  instanceId: idSchema,
  nativeSessionId: idSchema,
  adapterId: idSchema.nullable(),
  referenceUse: nativeSessionReferenceUseSchema,
  runId: idSchema.nullable(),
}).superRefine((reference, context) => {
  if ((reference.referenceUse === "active-projection") !== (reference.runId !== null)) {
    context.addIssue({
      code: "custom",
      path: ["runId"],
      message: "Only active projection references carry a run ID",
    });
  }
});
export const nativeSessionReferenceIndexV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  logicalSessionId: idSchema,
  references: z.array(nativeSessionReferenceV1Schema),
}).superRefine((index, context) => {
  if (index.references.some((reference) => reference.logicalSessionId !== index.logicalSessionId)) {
    context.addIssue({
      code: "custom",
      path: ["references"],
      message: "Native session references must belong to the indexed logical session",
    });
  }
});
export const canonicalChangeKindSchema = z.enum([
  "session-created",
  "content-updated",
  "metadata-updated",
  "workspace-updated",
  "project-updated",
  "branch-created",
  "tombstone-updated",
]);
export const canonicalChangeV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().positive(),
  logicalSessionId: idSchema,
  kind: canonicalChangeKindSchema,
  changedAt: timestampSchema,
});
export const canonicalChangeQuerySchema = z.strictObject({
  afterRevision: nonNegativeIntegerSchema,
  limit: z.number().int().positive().max(1_000),
});
export const canonicalChangePageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  afterRevision: nonNegativeIntegerSchema,
  throughRevision: nonNegativeIntegerSchema,
  currentRevision: nonNegativeIntegerSchema,
  hasMore: z.boolean(),
  changes: z.array(canonicalChangeV1Schema),
}).superRefine((page, context) => {
  if (page.throughRevision < page.afterRevision || page.currentRevision < page.throughRevision) {
    context.addIssue({
      code: "custom",
      path: ["throughRevision"],
      message: "Canonical change revisions must be monotonic",
    });
  }
  if (page.changes.some((change) => change.revision <= page.afterRevision || change.revision > page.throughRevision)) {
    context.addIssue({
      code: "custom",
      path: ["changes"],
      message: "Canonical changes must fall inside the page revision window",
    });
  }
  if (page.changes.some((change, index) => index > 0 && change.revision <= page.changes[index - 1]!.revision)) {
    context.addIssue({
      code: "custom",
      path: ["changes"],
      message: "Canonical changes must be strictly ordered by revision",
    });
  }
  const expectedThrough = page.changes.at(-1)?.revision ?? page.afterRevision;
  if (page.throughRevision !== expectedThrough || page.hasMore !== (page.throughRevision < page.currentRevision)) {
    context.addIssue({
      code: "custom",
      path: ["throughRevision"],
      message: "Canonical change page cursor does not match its rows",
    });
  }
});
export const sessionDerivationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  childSessionId: idSchema,
  parentSessionId: idSchema,
  baseVersionId: idSchema,
  kind: sessionDerivationKindSchema,
  triggerRunId: idSchema,
  triggerOperationId: idSchema,
  createdAt: timestampSchema,
});
export const logicalWorkspaceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: idSchema,
  parentId: idSchema.nullable(),
  name: z.string().min(1),
  sortKey: z.string(),
  deletedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export const workspaceMembershipSchema = z.strictObject({
  schemaVersion: z.literal(1),
  logicalSessionId: idSchema,
  workspaceId: idSchema.nullable(),
  displayOrder: nonNegativeIntegerSchema,
  pinned: z.boolean(),
  archived: z.boolean(),
  revision: nonNegativeIntegerSchema,
});
export const logicalProjectSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: idSchema,
  name: z.string().min(1),
  sourcePlatform: z.enum(["codex", "maintenance"]),
  sourceProjectId: z.string().min(1).nullable(),
  sortKey: z.string(),
  deletedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export const projectRootSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: idSchema,
  path: z.string().min(1),
  normalizedPath: z.string().min(1),
  ordinal: nonNegativeIntegerSchema,
});
export const projectMembershipSchema = z.strictObject({
  schemaVersion: z.literal(1),
  logicalSessionId: idSchema,
  projectId: idSchema.nullable(),
  revision: nonNegativeIntegerSchema,
});
export const canonicalDashboardSessionSummarySchema = z.strictObject({
  session: canonicalSessionRecordSchema,
  membership: workspaceMembershipSchema.nullable(),
});
export const canonicalDashboardWorkspaceSchema = z.strictObject({
  workspace: logicalWorkspaceSchema,
  sessions: z.array(canonicalDashboardSessionSummarySchema),
});
export const canonicalWorkspaceDirectorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaces: z.array(canonicalDashboardWorkspaceSchema),
  unclassified: z.array(canonicalDashboardSessionSummarySchema),
});
export const canonicalWorkspaceDirectoryResponseSchema = z.strictObject({
  directory: canonicalWorkspaceDirectorySchema,
});
export const canonicalDashboardProjectSchema = z.strictObject({
  project: logicalProjectSchema,
  roots: z.array(projectRootSchema),
  sessions: z.array(canonicalDashboardSessionSummarySchema),
});
export const canonicalProjectDirectorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  projects: z.array(canonicalDashboardProjectSchema),
  unclassified: z.array(canonicalDashboardSessionSummarySchema),
});
export const canonicalProjectDirectoryResponseSchema = z.strictObject({
  directory: canonicalProjectDirectorySchema,
});
export const canonicalLineageRelationSchema = z.strictObject({
  derivation: sessionDerivationSchema,
  session: canonicalSessionRecordSchema,
});
export const canonicalDashboardSessionDetailSchema = z.strictObject({
  schemaVersion: z.literal(1),
  session: canonicalSessionRecordSchema,
  membership: workspaceMembershipSchema.nullable(),
  workspace: logicalWorkspaceSchema.nullable(),
  projectMembership: projectMembershipSchema.nullable(),
  project: logicalProjectSchema.nullable(),
  projectRoots: z.array(projectRootSchema),
  nativeReferences: nativeSessionReferenceIndexV1Schema,
  events: z.array(canonicalEventV1Schema),
  parent: canonicalLineageRelationSchema.nullable(),
  children: z.array(canonicalLineageRelationSchema),
});
export const canonicalDashboardSessionResponseSchema = z.strictObject({
  session: canonicalDashboardSessionDetailSchema,
});
export const sessionTombstoneSchema = z.strictObject({
  schemaVersion: z.literal(1),
  logicalSessionId: idSchema,
  operationId: idSchema,
  checkpointId: idSchema,
  previousWorkspaceId: idSchema.nullable(),
  deletedAt: timestampSchema,
  retentionUntil: timestampSchema,
  restoredAt: timestampSchema.nullable(),
});

export const projectionRunStateSchema = z.enum([
  "preparing",
  "running",
  "draining",
  "verifying",
  "closed",
  "recovery-required",
  "recovering",
  "recovered",
  "quarantined",
  "cleanup-pending",
]);
export const projectionSessionModeSchema = z.enum([
  "maintenance-write",
  "codex-read-until-write",
  "hidden",
  "recovery-only",
]);
export const projectionOperationStatusSchema = z.enum([
  "pending",
  "committed",
  "failed",
  "quarantined",
]);
export const projectionRunSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: idSchema,
  leaseId: idSchema,
  branchId: idSchema,
  instanceId: idSchema,
  profileId: idSchema,
  dshVersion: idSchema,
  adapterId: idSchema,
  state: projectionRunStateSchema,
  startedAt: timestampSchema,
  heartbeatAt: timestampSchema,
  checkpointId: idSchema.nullable(),
});
export const projectionSessionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: idSchema,
  nativeSessionId: idSchema,
  logicalSessionId: idSchema,
  baseVersionId: idSchema.nullable(),
  mode: projectionSessionModeSchema,
  nativeRevision: nonNegativeIntegerSchema,
  lastCommittedOperationId: idSchema.nullable(),
  derivedChildSessionId: idSchema.nullable(),
});
export const projectionOperationReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: idSchema,
  runId: idSchema,
  logicalSessionId: idSchema,
  nativeSessionId: idSchema,
  status: projectionOperationStatusSchema,
  canonicalVersionId: idSchema.nullable(),
  projectionRevision: nonNegativeIntegerSchema,
  committedAt: timestampSchema.nullable(),
});
export const projectionCacheSessionStateV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  logicalSessionId: idSchema,
  nativeSessionId: idSchema,
  canonicalHeadVersionId: idSchema.nullable(),
  canonicalUpdatedAt: timestampSchema,
  title: z.string(),
  tags: z.array(z.string()),
  archivedAt: timestampSchema.nullable(),
  workspaceId: idSchema.nullable(),
  projectId: idSchema.nullable(),
  authorityScope: authorityScopeSchema,
  nativeRevision: nonNegativeIntegerSchema,
  nativeDigest: z.string().min(1),
});
export const projectionCacheWorkspaceStateV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  nativeWorkspaceId: idSchema,
  nativeDigest: z.string().min(1),
});
export const persistentProjectionCacheManifestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  cacheKey: z.string().min(1),
  adapterId: idSchema,
  adapterFingerprint: z.string().min(1),
  configurationDigest: z.string().min(1),
  lastAppliedRevision: nonNegativeIntegerSchema,
  sessions: z.array(projectionCacheSessionStateV1Schema),
  workspaces: z.array(projectionCacheWorkspaceStateV1Schema),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).superRefine((manifest, context) => {
  const logicalIds = new Set(manifest.sessions.map((session) => session.logicalSessionId));
  const nativeIds = new Set(manifest.sessions.map((session) => session.nativeSessionId));
  const workspaceIds = new Set(manifest.workspaces.map((workspace) => workspace.nativeWorkspaceId));
  if (logicalIds.size !== manifest.sessions.length || nativeIds.size !== manifest.sessions.length) {
    context.addIssue({ code: "custom", path: ["sessions"], message: "Projection cache session identities must be unique" });
  }
  if (workspaceIds.size !== manifest.workspaces.length) {
    context.addIssue({ code: "custom", path: ["workspaces"], message: "Projection cache workspace identities must be unique" });
  }
});
export const projectionDeltaApplyReceiptV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  cacheKey: z.string().min(1),
  baseline: z.boolean(),
  fromRevision: nonNegativeIntegerSchema,
  throughRevision: nonNegativeIntegerSchema,
  currentRevision: nonNegativeIntegerSchema,
  changedSessions: nonNegativeIntegerSchema,
  rewrittenSessions: nonNegativeIntegerSchema,
  removedSessions: nonNegativeIntegerSchema,
  unchangedSessions: nonNegativeIntegerSchema,
  rewrittenWorkspaces: nonNegativeIntegerSchema,
  removedWorkspaces: nonNegativeIntegerSchema,
}).superRefine((receipt, context) => {
  if (receipt.fromRevision > receipt.throughRevision || receipt.throughRevision > receipt.currentRevision) {
    context.addIssue({ code: "custom", path: ["throughRevision"], message: "Projection delta revisions must be monotonic" });
  }
});

export const statusStageSchema = z.enum(STATUS_STAGES);
export const statusEventStateSchema = z.enum(["started", "succeeded", "failed"]);
export const statusEventV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  id: idSchema,
  at: timestampSchema,
  runId: idSchema,
  leaseId: idSchema,
  profileId: idSchema,
  adapterId: idSchema,
  dshVersion: idSchema,
  stage: statusStageSchema,
  state: statusEventStateSchema,
  logicalSessionId: idSchema.nullable(),
  nativeSessionId: idSchema.nullable(),
  operationId: idSchema.nullable(),
  parentEventId: idSchema.nullable(),
  spanId: idSchema,
  errorCode: z.string().nullable(),
  durationMs: nonNegativeIntegerSchema.nullable(),
  diagnosticDetailRef: z.string().nullable(),
});
export const statusEventQuerySchema = z.strictObject({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  runId: idSchema.optional(),
  logicalSessionId: idSchema.optional(),
  operationId: idSchema.optional(),
  stage: statusStageSchema.optional(),
  spanId: idSchema.optional(),
});

export const adapterCapabilitySchema = z.enum([
  "session-persistence",
  "append",
  "revision-check",
  "read-from",
  "borrow-session",
  "snapshots",
  "workspace-projection",
  "annotation",
  "sticker-obsidian-reference",
  "unknown-event-round-trip",
  "stable-native-session-id",
  "metadata-hot-update",
  "deep-link-resolution",
  "recovery",
  "projection-verification",
]);
export const adapterVerificationStatusSchema = z.enum([
  "verified",
  "compatible",
  "experimental",
  "failed",
]);
export const adapterManifestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  id: idSchema,
  displayName: z.string().min(1),
  adapterApiVersion: z.literal(1),
  packageVersion: z.string().min(1),
  testedDshVersions: z.array(z.string().min(1)),
  declaredDshRange: z.string().min(1),
  capabilities: z.array(adapterCapabilitySchema),
});

export const platformSessionKeySchema = z.strictObject({
  platform: platformKindSchema,
  instanceId: idSchema,
  sessionId: idSchema,
});

export const registeredInstanceSchema = z.strictObject({
  id: idSchema,
  platform: platformKindSchema,
  displayName: z.string(),
  root: z.string().min(1),
  platformVersion: z.string().min(1),
});

export const compatibilityIssueSchema = z.strictObject({
  code: idSchema,
  message: z.string(),
  sourceType: z.string().optional(),
});

export const compatibilityReportSchema = z.strictObject({
  status: compatibilityStatusSchema,
  issues: z.array(compatibilityIssueSchema),
});

export const adapterContractRefSchema = z.strictObject({
  adapter: idSchema,
  platformVersion: idSchema,
  schemaFingerprint: idSchema,
});

export const observationHintSchema = z.strictObject({
  size: nonNegativeIntegerSchema.optional(),
  mtimeNs: z.string().optional(),
  sourceHash: z.string().optional(),
  eventCount: nonNegativeIntegerSchema.optional(),
});

export const stateFingerprintSchema = z.strictObject({
  platform: platformKindSchema,
  instanceId: idSchema,
  sessionId: idSchema,
  kind: z.enum(["catalog", "content"]),
  value: idSchema,
});

export const scanCursorSchema = z.strictObject({ opaque: z.string() });

export const platformSessionSummarySchema = z.strictObject({
  key: platformSessionKeySchema,
  title: z.string(),
  archived: z.boolean(),
  workspaceId: z.string().nullable(),
  workspaceLabel: z.string().nullable(),
  updatedAt: timestampSchema,
  hint: observationHintSchema,
});

export const adapterProbeSchema = z.strictObject({
  status: compatibilityStatusSchema,
  contract: adapterContractRefSchema,
  capabilities: z.array(z.enum(["list", "observe", "normalize", "verify-read"])),
  issues: z.array(compatibilityIssueSchema),
});

export const stableObservationSchema = z.strictObject({
  kind: z.literal("stable"),
  key: platformSessionKeySchema,
  fingerprint: stateFingerprintSchema,
  payload: z.unknown(),
});

export const unstableReadSchema = z.strictObject({
  kind: z.literal("unstable"),
  key: platformSessionKeySchema,
  reason: z.string(),
  retryable: z.literal(true),
});

export const expectedPlatformStateSchema = z.strictObject({
  fingerprints: z.array(stateFingerprintSchema),
});

export const verificationResultSchema = z.strictObject({
  ok: z.boolean(),
  fingerprints: z.array(stateFingerprintSchema),
  issues: z.array(compatibilityIssueSchema),
});

export const provenanceSchema = z.strictObject({
  platform: platformKindSchema,
  instanceId: idSchema,
  sessionId: idSchema,
  observedAt: timestampSchema,
  sourceVersion: z.string().optional(),
});

export const sourceAnchorSchema = z.strictObject({
  platform: platformKindSchema,
  instanceId: idSchema,
  sessionId: idSchema,
  eventId: z.string().optional(),
  sequence: nonNegativeIntegerSchema,
});

export const attachmentRefSchema = z.strictObject({
  name: z.string(),
  mediaType: z.string().optional(),
  source: z.string(),
});

export const normalizedEventSchema = z.strictObject({
  id: idSchema,
  parentId: z.string().nullable(),
  sequence: nonNegativeIntegerSchema,
  kind: z.enum(["message", "tool-import", "attachment", "metadata"]),
  role: z.enum(["user", "assistant", "system", "tool", "unknown"]),
  content: z.string(),
  attachments: z.array(attachmentRefSchema),
  source: sourceAnchorSchema,
  extensions: z.record(z.string(), jsonValueSchema),
});

export const normalizedSessionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  key: platformSessionKeySchema,
  title: z.string(),
  archived: z.boolean(),
  workspaceId: z.string().nullable(),
  events: z.array(normalizedEventSchema),
  bodyHash: idSchema,
  metadataHash: idSchema,
  provenance: provenanceSchema,
  compatibility: compatibilityReportSchema,
});

export const sessionVersionManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: idSchema,
  logicalSessionId: idSchema,
  parents: z.array(idSchema).max(2),
  bodyObject: idSchema,
  bodyHash: idSchema,
  metadataHash: idSchema,
  source: provenanceSchema,
  compatibility: compatibilityReportSchema,
});

export const logicalSessionSchema = z.strictObject({
  id: idSchema,
  displayTitle: z.string(),
  canonicalVersionId: z.string().nullable(),
  syncMode: syncModeSchema,
  archived: z.boolean(),
  labels: z.array(z.string()),
  createdAt: timestampSchema,
});

export const platformBindingSchema = z.strictObject({
  id: idSchema,
  logicalSessionId: idSchema,
  key: platformSessionKeySchema,
  adapterContract: adapterContractRefSchema,
  lastCommonVersionId: z.string().nullable(),
  status: bindingStatusSchema,
});

export const nativeMirrorRecordSchema = z.strictObject({
  logicalSessionId: idSchema,
  state: nativeMirrorStateSchema,
  codexBindingId: idSchema.nullable(),
  dshBindingId: idSchema.nullable(),
  commonVersionId: idSchema.nullable(),
  codexVersionId: idSchema.nullable(),
  dshVersionId: idSchema.nullable(),
  lastTransactionId: idSchema.nullable(),
  pauseReason: z.string().nullable(),
  updatedAt: timestampSchema,
});

export const matchCandidateSchema = z.strictObject({
  id: idSchema,
  leftBindingId: idSchema,
  rightKey: platformSessionKeySchema,
  reason: z.string(),
  confidence: z.enum(["high", "low", "conflict"]),
  createdAt: timestampSchema,
  resolvedAt: timestampSchema.optional(),
});

export const checkpointSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  description: z.string(),
  refs: z.record(z.string(), idSchema),
  backupTransactionIds: z.array(idSchema),
  createdBy: z.string(),
  createdAt: timestampSchema,
});

export const versionNodeSchema = z.strictObject({
  id: idSchema,
  parents: z.array(idSchema).max(2),
});

export const versionGraphDataSchema = z.strictObject({
  nodes: z.array(versionNodeSchema),
});

export const newVersionSchema = sessionVersionManifestSchema.omit({
  schemaVersion: true,
  id: true,
});

export const observedHeadSchema = z.strictObject({
  bindingId: idSchema,
  versionId: idSchema,
  observedAt: timestampSchema,
  fingerprint: stateFingerprintSchema,
});

export const repositoryCountsSchema = z.strictObject({
  logicalSessions: nonNegativeIntegerSchema,
  bindings: nonNegativeIntegerSchema,
  versions: nonNegativeIntegerSchema,
  candidates: nonNegativeIntegerSchema,
  plans: nonNegativeIntegerSchema,
});

export const observationRecordSchema = z.strictObject({
  logicalSession: logicalSessionSchema,
  binding: platformBindingSchema,
  version: sessionVersionManifestSchema,
  head: observedHeadSchema,
  candidates: z.array(matchCandidateSchema),
});

export const repositoryWriteResultSchema = z.strictObject({
  createdLogicalSessions: nonNegativeIntegerSchema,
  createdBindings: nonNegativeIntegerSchema,
  createdVersions: nonNegativeIntegerSchema,
  createdCandidates: nonNegativeIntegerSchema,
});

export const gcPolicySchema = z.strictObject({
  reachableObjectIds: z.array(idSchema),
  olderThan: timestampSchema.optional(),
  dryRun: z.boolean(),
});

export const gcReportSchema = z.strictObject({
  reachableObjects: nonNegativeIntegerSchema,
  retainedObjects: nonNegativeIntegerSchema,
  deletedObjects: nonNegativeIntegerSchema,
  deletedBytes: nonNegativeIntegerSchema,
  items: z.array(
    z.strictObject({
      objectId: idSchema,
      disposition: z.enum(["retained", "deletable", "deleted"]),
      reason: z.enum(["reachable", "retention-window", "unreachable"]),
      bytes: nonNegativeIntegerSchema,
    }),
  ),
});

export const backupProtectionSchema = z.strictObject({
  transactionId: idSchema,
  reasons: z.array(z.enum(["checkpoint", "unresolved-transaction"])).min(1),
});

export const bindingSnapshotSchema = z.strictObject({
  bindingId: idSchema,
  key: platformSessionKeySchema,
  versionId: idSchema,
  fingerprints: z.array(stateFingerprintSchema),
});

export const confirmationRequirementSchema = z.strictObject({
  kind: z.enum(["review", "destructive"]),
  code: idSchema,
  message: z.string(),
});

export const plannedOperationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("create-target-session"), targetInstanceId: idSchema }),
  z.strictObject({
    type: z.literal("append-events"),
    fromIndex: nonNegativeIntegerSchema,
    eventIds: z.array(idSchema),
  }),
  z.strictObject({ type: z.literal("update-title"), title: z.string() }),
  z.strictObject({ type: z.literal("update-archive"), archived: z.boolean() }),
  z.strictObject({ type: z.literal("deletion-candidate"), missing: platformSessionKeySchema }),
  z.strictObject({
    type: z.literal("require-review"),
    reason: z.enum(["DIVERGED", "REWRITTEN", "METADATA_CONFLICT", "IDENTITY_CONFLICT"]),
  }),
]);

export const scanRequestSchema = z.strictObject({
  instanceIds: z.array(idSchema).min(1),
});

export const diffRequestSchema = z.strictObject({
  logicalSessionId: idSchema,
  sourceBindingId: z.string().min(1).optional(),
  targetBindingId: z.string().min(1).optional(),
});

export const planRequestSchema = z.strictObject({
  logicalSessionId: idSchema,
  sourceBindingId: idSchema,
  targetBindingId: z.string().min(1).optional(),
  createdAt: timestampSchema,
});

export const syncPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: idSchema,
  hash: idSchema,
  createdAt: timestampSchema,
  logicalSessionId: idSchema,
  baseVersionId: z.string().min(1).optional(),
  source: bindingSnapshotSchema,
  target: bindingSnapshotSchema.optional(),
  adapterContracts: z.array(adapterContractRefSchema),
  operations: z.array(plannedOperationSchema),
  risk: z.enum(["safe", "review", "destructive"]),
  confirmations: z.array(confirmationRequirementSchema),
  preconditions: z.array(stateFingerprintSchema),
});

export const jobStatusSchema = z.enum(["queued", "running", "completed", "failed"]);

export const jobRefSchema = z.strictObject({
  id: idSchema,
  status: jobStatusSchema,
});

const jobEventBaseShape = {
  jobId: idSchema,
  sequence: nonNegativeIntegerSchema,
  at: timestampSchema,
};

export const jobEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...jobEventBaseShape, type: z.literal("queued") }),
  z.strictObject({ ...jobEventBaseShape, type: z.literal("running") }),
  z.strictObject({
    ...jobEventBaseShape,
    type: z.literal("progress"),
    current: nonNegativeIntegerSchema,
    total: nonNegativeIntegerSchema.optional(),
    message: z.string(),
  }),
  z.strictObject({ ...jobEventBaseShape, type: z.literal("completed"), result: jsonValueSchema }),
  z.strictObject({
    ...jobEventBaseShape,
    type: z.literal("failed"),
    code: idSchema,
    message: z.string(),
  }),
]);

export const sessionQuerySchema = z.strictObject({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  platform: platformKindSchema.optional(),
  status: sessionStatusSchema.optional(),
  workspaceId: z.string().min(1).nullable().optional(),
});

export const workspaceRefSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
});

export const sessionSummarySchema = z.strictObject({
  logicalSessionId: idSchema,
  title: z.string(),
  archived: z.boolean(),
  platforms: z.array(platformKindSchema),
  status: sessionStatusSchema,
  updatedAt: timestampSchema,
  workspace: workspaceRefSchema.nullable(),
});

export const workspaceSummarySchema = z.strictObject({
  workspace: workspaceRefSchema.nullable(),
  sessionCount: nonNegativeIntegerSchema,
  conflictCount: nonNegativeIntegerSchema,
  unmappedCount: nonNegativeIntegerSchema,
  platforms: z.array(platformKindSchema),
  updatedAt: timestampSchema,
});

export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item), nextCursor: z.string().optional() });

export const versionGraphPageSchema = z.strictObject({
  nodes: z.array(sessionVersionManifestSchema),
  refs: z.array(z.strictObject({ name: z.string(), versionId: idSchema })),
  nextCursor: z.string().optional(),
});

export const instanceStatusSchema = z.strictObject({
  id: idSchema,
  platform: platformKindSchema,
  displayName: z.string(),
  compatibility: compatibilityReportSchema,
});

export const discoveryResultSchema = z.strictObject({
  createdLogicalSessions: nonNegativeIntegerSchema,
  createdBindings: nonNegativeIntegerSchema,
  createdVersions: nonNegativeIntegerSchema,
  createdCandidates: nonNegativeIntegerSchema,
  skippedSessions: nonNegativeIntegerSchema,
  platformWrites: z.literal(0),
});

export const sessionDiffSchema = z.strictObject({
  relation: z.enum(["equal", "source-ahead", "target-ahead", "diverged", "unrelated"]),
  conversation: z.enum(["unchanged", "append-only", "rewritten"]),
  metadata: z.enum(["unchanged", "source-only", "target-only", "metadata-conflict"]),
  mergeBase: z.string().optional(),
});

export const engineStatusSchema = z.strictObject({
  ready: z.boolean(),
  instanceCount: nonNegativeIntegerSchema,
  lastScanAt: timestampSchema.optional(),
});

export const writeCapabilitySchema = z.enum([
  "create-session",
  "append-events",
  "update-title",
  "update-archive",
  "verify",
  "restore",
]);

export const writeProbeSchema = z.strictObject({
  status: compatibilityStatusSchema,
  contract: adapterContractRefSchema,
  capabilities: z.array(writeCapabilitySchema),
  issues: z.array(compatibilityIssueSchema),
});

export const transactionStatusSchema = z.enum([
  "prepared",
  "backing-up",
  "applying",
  "verifying",
  "completed",
  "restoring",
  "restored",
  "restore-failed",
  "manual-review",
]);

export const transactionContextSchema = z.strictObject({
  id: idSchema,
  planId: idSchema,
  planHash: idSchema,
  startedAt: timestampSchema,
});

export const preparedWriteSchema = z.strictObject({
  id: idSchema,
  planId: idSchema,
  planHash: idSchema,
  platform: platformKindSchema,
  instanceId: idSchema,
  rootIdentity: idSchema,
  targetKey: platformSessionKeySchema.optional(),
  expected: expectedPlatformStateSchema,
  payload: jsonValueSchema,
});

export const backupManifestEntrySchema = z.strictObject({
  logicalName: idSchema,
  objectId: idSchema,
  size: nonNegativeIntegerSchema,
  sha256: idSchema,
  required: z.boolean(),
});

export const backupManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  transactionId: idSchema,
  entries: z.array(backupManifestEntrySchema),
  createdAt: timestampSchema,
  hash: idSchema,
});

export const writeReceiptSchema = z.strictObject({
  transactionId: idSchema,
  platform: platformKindSchema,
  instanceId: idSchema,
  targetKey: platformSessionKeySchema.optional(),
  fingerprints: z.array(stateFingerprintSchema),
  details: jsonValueSchema,
});

export const restoreReceiptSchema = z.strictObject({
  transactionId: idSchema,
  restored: z.boolean(),
  fingerprints: z.array(stateFingerprintSchema),
  issues: z.array(compatibilityIssueSchema),
});

export const transactionRecordSchema = z.strictObject({
  id: idSchema,
  planId: idSchema,
  planHash: idSchema,
  platform: platformKindSchema,
  instanceId: idSchema,
  rootIdentity: idSchema,
  adapterContract: adapterContractRefSchema,
  status: transactionStatusSchema,
  result: jsonValueSchema.optional(),
  errorCode: z.string().optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const transactionRefSchema = z.strictObject({
  id: idSchema,
  status: transactionStatusSchema,
});

export const transactionStepSchema = z.strictObject({
  transactionId: idSchema,
  sequence: nonNegativeIntegerSchema,
  status: transactionStatusSchema,
  step: idSchema,
  data: jsonValueSchema,
  previousHash: z.string().nullable(),
  entryHash: idSchema,
  at: timestampSchema,
});

export const storedConfirmationSchema = z.strictObject({
  tokenHash: idSchema,
  operation: idSchema,
  resourceId: idSchema,
  operationHash: idSchema,
  expiresAt: timestampSchema,
  createdAt: timestampSchema,
  consumedAt: timestampSchema.nullable(),
});

export const applyPlanRequestSchema = z.strictObject({ planId: idSchema });
export const restoreTransactionRequestSchema = z.strictObject({
  transactionId: idSchema,
  confirmationToken: idSchema,
});
export const restoreOperationRequestSchema = z.strictObject({ confirmationToken: idSchema });
export const createCheckpointRequestSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string(),
  refs: z.record(z.string(), idSchema),
  backupTransactionIds: z.array(idSchema),
  createdBy: z.string().min(1),
  createdAt: timestampSchema,
});
export const checkpointRestoreRequestSchema = z.strictObject({
  checkpointId: idSchema,
  targetInstanceId: idSchema,
  createdAt: timestampSchema,
});
export const checkpointRestoreBodySchema = z.strictObject({
  targetInstanceId: idSchema,
  createdAt: timestampSchema,
});
export const confirmationScopeSchema = z.strictObject({
  operation: idSchema,
  resourceId: idSchema,
  operationHash: idSchema,
});
export const issuedConfirmationSchema = confirmationScopeSchema.extend({
  token: idSchema,
  expiresAt: timestampSchema,
});

export const apiErrorBodySchema = z.strictObject({ code: idSchema, message: z.string() });
export const apiErrorResponseSchema = z.strictObject({ error: apiErrorBodySchema });
export const engineStatusResponseSchema = z.strictObject({ status: engineStatusSchema });
export const sessionListResponseSchema = z.strictObject({ page: pageSchema(sessionSummarySchema) });
export const versionGraphResponseSchema = z.strictObject({ graph: versionGraphPageSchema });
export const planResponseSchema = z.strictObject({ plan: syncPlanSchema });
export const jobAcceptedResponseSchema = z.strictObject({ job: jobRefSchema });
export const transactionResponseSchema = z.strictObject({ transaction: transactionRecordSchema });
export const checkpointResponseSchema = z.strictObject({ checkpoint: checkpointSchema });

export const sessionDetailSchema = z.strictObject({
  summary: sessionSummarySchema,
  bindings: z.array(platformBindingSchema),
  heads: z.array(observedHeadSchema),
});

export const versionContentSchema = z.strictObject({
  manifest: sessionVersionManifestSchema,
  session: normalizedSessionSchema,
});

export const transactionQuerySchema = z.strictObject({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  status: transactionStatusSchema.optional(),
});

export const transactionSummarySchema = z.strictObject({
  id: idSchema,
  planId: idSchema,
  platform: platformKindSchema,
  instanceId: idSchema,
  status: transactionStatusSchema,
  errorCode: z.string().optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const planQuerySchema = z.strictObject({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  risk: z.enum(["safe", "review", "destructive"]).optional(),
});

export const planSummarySchema = z.strictObject({
  id: idSchema,
  logicalSessionId: idSchema,
  createdAt: timestampSchema,
  risk: z.enum(["safe", "review", "destructive"]),
  operationCount: nonNegativeIntegerSchema,
  confirmationCount: nonNegativeIntegerSchema,
});

export const transactionDetailSchema = z.strictObject({
  transaction: transactionRecordSchema,
  steps: z.array(transactionStepSchema),
  backup: backupManifestSchema.optional(),
  recovery: z.strictObject({
    action: z.enum(["recover-interrupted", "restore-completed", "none"]),
    allowed: z.boolean(),
    confirmationRequired: z.boolean(),
    reason: z.string().min(1),
    backupHash: idSchema.optional(),
  }),
});

export const adapterDiagnosticSchema = z.strictObject({
  instance: instanceStatusSchema,
  readContract: adapterContractRefSchema,
  writeContract: adapterContractRefSchema.optional(),
  writeCapabilities: z.array(z.string()),
  writeStatus: z.union([compatibilityStatusSchema, z.literal("unavailable")]),
  issues: z.array(compatibilityIssueSchema),
});

export const maintenanceSettingsSchema = z.strictObject({
  codexInstanceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u).nullable(),
  dshInstanceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u).nullable(),
  workspaceMappingId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u).nullable(),
  syncSingleSidedTitle: z.boolean(),
  syncArchive: z.boolean(),
  scanScope: z.enum(["current", "registered"]),
  backupRetention: z.number().int().min(1).max(10_000),
  allowBatchSafeApply: z.boolean(),
});

export const maintenanceSettingsPatchSchema = maintenanceSettingsSchema.partial().strict();

export const dashboardOverviewSchema = z.strictObject({
  sessions: nonNegativeIntegerSchema,
  conflicts: nonNegativeIntegerSchema,
  unmapped: nonNegativeIntegerSchema,
  unresolvedTransactions: nonNegativeIntegerSchema,
  instances: z.array(instanceStatusSchema),
});

export const sessionDetailResponseSchema = z.strictObject({ session: sessionDetailSchema });
export const versionContentResponseSchema = z.strictObject({ version: versionContentSchema });
export const transactionListResponseSchema = z.strictObject({ page: pageSchema(transactionSummarySchema) });
export const planListResponseSchema = z.strictObject({ page: pageSchema(planSummarySchema) });
export const transactionDetailResponseSchema = z.strictObject({ detail: transactionDetailSchema });
export const checkpointListResponseSchema = z.strictObject({ checkpoints: z.array(checkpointSchema) });
export const diagnosticsResponseSchema = z.strictObject({ diagnostics: z.array(adapterDiagnosticSchema) });
export const settingsResponseSchema = z.strictObject({ settings: maintenanceSettingsSchema });
export const overviewResponseSchema = z.strictObject({ overview: dashboardOverviewSchema });
export const dashboardLaunchInfoSchema = z.strictObject({ url: z.string().url(), expiresAt: timestampSchema });
export const dashboardLaunchRequestSchema = z.strictObject({
  logicalSessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u).optional(),
});
export const dashboardUiSessionSchema = z.strictObject({
  csrfToken: idSchema,
  expiresAt: timestampSchema,
  initialLogicalSessionId: idSchema.optional(),
});
export const platformSessionResolutionRequestSchema = z.strictObject({
  platform: z.literal("dsh"),
  instanceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
  sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
});
export const platformSessionResolutionSchema = z.strictObject({
  logicalSessionId: idSchema,
  bindingId: idSchema,
  title: z.string(),
  status: sessionStatusSchema,
});
export const nativeMirrorActionSchema = z.enum([
  "enable", "pause", "resume", "keep-branches", "choose-canonical", "unlink", "reset-target", "delete-target",
]);
export const nativeMirrorActionRequestSchema = z.strictObject({
  action: nativeMirrorActionSchema,
  platform: platformKindSchema.optional(),
  reason: z.string().max(1000).optional(),
  confirmationToken: z.string().min(1).optional(),
});
export const nativeMirrorActionPreviewSchema = z.strictObject({
  logicalSessionId: idSchema,
  action: nativeMirrorActionSchema,
  allowed: z.boolean(),
  confirmationRequired: z.boolean(),
  operationHash: idSchema,
  message: z.string(),
  mirror: nativeMirrorRecordSchema.optional(),
});
export const nativeMirrorListResponseSchema = z.strictObject({ mirrors: z.array(nativeMirrorRecordSchema) });
export const nativeMirrorResponseSchema = z.strictObject({ mirror: nativeMirrorRecordSchema });
export const nativeMirrorPreviewResponseSchema = z.strictObject({ preview: nativeMirrorActionPreviewSchema });
export const dashboardLaunchResponseSchema = z.strictObject({ launch: dashboardLaunchInfoSchema });
export const dashboardUiSessionResponseSchema = z.strictObject({ session: dashboardUiSessionSchema });
export const platformSessionResolutionResponseSchema = z.strictObject({ resolution: platformSessionResolutionSchema });

export const continuationModeSchema = z.enum(["full", "checkpoint", "structured-summary"]);
export const continuationJobStatusSchema = z.enum([
  "prepared",
  "creating",
  "started",
  "verifying",
  "completed",
  "failed",
  "manual-review",
]);

export const codexContinuationTargetSchema = z.strictObject({
  id: idSchema,
  codexInstanceId: idSchema,
  platformVersion: idSchema,
  cwd: z.string().min(1),
  runtimeWorkspaceRoots: z.array(z.string().min(1)),
  contextWindowTokens: z.number().int().positive(),
  inputBudgetRatio: z.number().positive().max(1),
  model: z.string().min(1).optional(),
  permissions: z.string().min(1).optional(),
  codexHome: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
});

export const continuationPreviewRequestSchema = z.strictObject({
  logicalSessionId: idSchema,
  sourceVersionId: idSchema,
  targetPresetId: idSchema,
  mode: continuationModeSchema,
  checkpointStartSequence: nonNegativeIntegerSchema.optional(),
});

export const resolutionContinuationRequestSchema = z.strictObject({
  logicalSessionId: idSchema,
  leftVersionId: idSchema,
  rightVersionId: idSchema,
  commonAncestorVersionId: idSchema.optional(),
  mergeNote: z.string().min(1),
  targetPresetId: idSchema,
  mode: continuationModeSchema,
  checkpointStartSequence: nonNegativeIntegerSchema.optional(),
});

export const continuationRequestSchema = z.union([
  continuationPreviewRequestSchema,
  resolutionContinuationRequestSchema,
]);

export const continuationPreviewSchema = z.strictObject({
  mode: continuationModeSchema,
  allowed: z.boolean(),
  estimatedTokens: nonNegativeIntegerSchema,
  tokenBudget: z.number().int().positive(),
  sourceVersionIds: z.array(idSchema).min(1).max(2),
  archiveObjectIds: z.array(idSchema).min(1).max(2),
  omissions: z.array(z.strictObject({
    sourceVersionId: idSchema,
    reason: z.enum(["checkpoint", "structured-summary"]),
    eventCount: nonNegativeIntegerSchema,
    characterCount: nonNegativeIntegerSchema,
  })),
  reason: z.string().optional(),
});

export const continuationJobSchema = z.strictObject({
  id: idSchema,
  requestHash: idSchema,
  request: continuationRequestSchema,
  logicalSessionId: idSchema,
  sourceVersionIds: z.array(idSchema).min(1).max(2),
  targetPresetId: idSchema,
  mode: continuationModeSchema,
  handoffObjectId: idSchema,
  status: continuationJobStatusSchema,
  codexThreadId: idSchema.optional(),
  codexTurnId: idSchema.optional(),
  errorCode: idSchema.optional(),
  verification: jsonValueSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const continuationPreviewResponseSchema = z.strictObject({ preview: continuationPreviewSchema });
export const continuationJobResponseSchema = z.strictObject({ continuation: continuationJobSchema });

export const continuationTransitionSchema = z.strictObject({
  expected: z.array(continuationJobStatusSchema).min(1),
  status: continuationJobStatusSchema,
  updatedAt: timestampSchema,
  codexThreadId: idSchema.optional(),
  codexTurnId: idSchema.optional(),
  errorCode: idSchema.optional(),
  verification: jsonValueSchema.optional(),
});
