import { z } from "zod";

import type { JsonValue } from "./model.js";

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
  limit: z.number().int().min(1).max(200).optional(),
  platform: platformKindSchema.optional(),
  status: sessionStatusSchema.optional(),
});

export const sessionSummarySchema = z.strictObject({
  logicalSessionId: idSchema,
  title: z.string(),
  archived: z.boolean(),
  platforms: z.array(platformKindSchema),
  status: sessionStatusSchema,
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

export const apiErrorBodySchema = z.strictObject({ code: idSchema, message: z.string() });
export const apiErrorResponseSchema = z.strictObject({ error: apiErrorBodySchema });
export const engineStatusResponseSchema = z.strictObject({ status: engineStatusSchema });
export const sessionListResponseSchema = z.strictObject({ page: pageSchema(sessionSummarySchema) });
export const versionGraphResponseSchema = z.strictObject({ graph: versionGraphPageSchema });
export const planResponseSchema = z.strictObject({ plan: syncPlanSchema });
export const jobAcceptedResponseSchema = z.strictObject({ job: jobRefSchema });
