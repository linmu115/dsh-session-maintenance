import { z } from "zod";

/**
 * The instance side of a takeover handshake.
 *
 * A DSH instance can be started without the Maintenance Engine: the user opens
 * the instance, the Engine comes up later. So the instance cannot wait to be
 * told what to do — it leaves a durable, discoverable statement that it is
 * running and *can* be taken over, and the Engine picks it up when it appears.
 *
 * The file is the discovery end of the handshake and carries no authority: it
 * only asserts the instance's own identity and where its runtime listens. The
 * Engine still has to verify the claim (see the lease inspection) and still
 * decides on its own what a takeover means. Consequently the lease never
 * contains a run, a runtime client id or an Engine capability.
 */

/** Schema version of the instance lease file; a new shape needs a new version. */
export const INSTANCE_LEASE_SCHEMA_VERSION = 1 as const;

/**
 * The file name both sides use for one instance's lease.
 *
 * It has to be derivable from the instance identity alone, because the instance
 * writes the file before any Engine is running and the Engine later looks for
 * it knowing only the instance and profile it was asked to take over. Both
 * halves must therefore use this one function rather than a local convention.
 */
export function maintenanceInstanceIdFor(instanceId: string, profileId: string): string {
  return `${instanceId}__${profileId}`.replaceAll(/[^A-Za-z0-9._-]/gu, '-');
}

const safeId = z.string().min(1).max(128);
const loopbackOrigin = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    && url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "";
}, "Use an exact loopback HTTP origin");

export const instanceLeaseStateSchema = z.enum([
  /** The instance is running and offers no run yet. */
  "idle",
  /** The instance was asked to attach and is attaching or attached to an Engine run. */
  "attached",
  /** The instance is shutting down; a new takeover should wait for a fresh lease. */
  "stopping",
]);
export type InstanceLeaseState = z.infer<typeof instanceLeaseStateSchema>;

/** What the instance states about its own runtime. Every field is a claim the Engine verifies. */
export const instanceLeaseSchema = z.strictObject({
  schemaVersion: z.literal(INSTANCE_LEASE_SCHEMA_VERSION),
  instanceId: safeId,
  profileId: safeId,
  /** Process identity, so the Engine can tell a live instance from a stale file. */
  pid: z.number().int().positive(),
  /** Process start time as the OS reports it; distinguishes a reused PID. */
  processStartedAt: z.iso.datetime(),
  /** The instance's own DSH Home, so a folder connection and the lease can be tied together. */
  homeRoot: z.string().min(1).max(32_768),
  /** Where this instance's runtime listens, when the instance itself can state it. */
  runtimeUrl: loopbackOrigin.nullable(),
  state: instanceLeaseStateSchema,
  /** Run this instance believes it is attached to, so a stale attachment is visible. */
  attachedRunId: safeId.nullable(),
  updatedAt: z.iso.datetime(),
});
export type InstanceLease = z.infer<typeof instanceLeaseSchema>;

/**
 * The Engine side of the handshake: what the instance must present in order to
 * claim a prepared run.
 *
 * The Engine prepares the run first — it owns Canonical state and decides the
 * scope — and then publishes this handoff. `ticketId` is a single-use
 * capability: the instance proves it can read the Engine's own state root, and
 * the Engine never has to accept a run request from an arbitrary local process.
 */
export const takeoverHandoffSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ticketId: safeId,
  instanceId: safeId,
  profileId: safeId,
  runId: safeId,
  /** Held only by the instance process, exactly as in the Launcher handoff. */
  runtimeClientId: safeId,
  ownerClientId: safeId,
  temporaryPersistenceRootId: safeId,
  maintenanceEndpoint: loopbackOrigin,
  dshVersion: z.string().min(1).max(100),
  adapterId: safeId.nullable(),
  nativeMode: z.literal("persistent-native-v1").nullable(),
  createdAt: z.iso.datetime(),
  /** A handoff the instance already claimed; kept so a restart does not attach twice. */
  claimedAt: z.iso.datetime().nullable(),
});
export type TakeoverHandoff = z.infer<typeof takeoverHandoffSchema>;

/** A handoff the instance may claim, or the receipt of the claim. */
export const takeoverClaimRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ticketId: safeId,
  instanceId: safeId,
  profileId: safeId,
  pid: z.number().int().positive(),
});
export type TakeoverClaimRequest = z.infer<typeof takeoverClaimRequestSchema>;

/** What the Engine needs in order to look for an instance in a selected folder. */
export const instanceTakeoverRequestSchema = z.strictObject({
  targetId: safeId,
  /** `detect` only reports whether the instance is running; `takeover` prepares a run for it. */
  mode: z.enum(["detect", "takeover"]),
});
export type InstanceTakeoverRequest = z.infer<typeof instanceTakeoverRequestSchema>;

/**
 * What the Engine concluded about one instance's lease.
 *
 * `running` is the only decision a takeover may act on: the OS confirmed the
 * very process the lease names is alive. `not-running` means a lease exists but
 * its process is gone or was never confirmed — the instance is connected but
 * not taken over. `absent` means no lease was left at all. `stale` means a lease
 * exists but cannot be trusted (unreadable, wrong shape, or the OS reports a
 * different process), so it is reported and never acted on.
 */
export const instanceLeaseDecisionSchema = z.enum(["running", "not-running", "absent", "stale"]);
export type InstanceLeaseDecision = z.infer<typeof instanceLeaseDecisionSchema>;

/** The lease the Engine actually verified, including why it accepted or refused it. */
export const instanceLeaseInspectionSchema = z.strictObject({
  instanceId: safeId,
  profileId: safeId,
  homeRoot: z.string(),
  /** `null` when neither the instance nor its configuration names an endpoint. */
  runtimeUrl: loopbackOrigin.nullable(),
  /**
   * Where the endpoint came from. The instance states it when it can; otherwise
   * the Engine reads it out of the instance's own configuration, because the
   * host does not tell a plugin which port it was started on. `none` means no
   * endpoint could be established at all, which is reported rather than worked
   * around by asking the operator to set a variable.
   */
  runtimeUrlSource: z.enum(["instance", "configuration", "none"]),
  /** Present only when the OS confirmed this process is the one the lease names. */
  process: z.strictObject({ pid: z.number().int().positive(), startedAt: z.iso.datetime() }).nullable(),
  state: instanceLeaseStateSchema.nullable(),
  attachedRunId: safeId.nullable(),
  decision: instanceLeaseDecisionSchema,
  reason: z.string(),
});
export type InstanceLeaseInspection = z.infer<typeof instanceLeaseInspectionSchema>;

/** The answer to either takeover mode; a handoff is present only after a successful takeover. */
export const instanceTakeoverResponseSchema = z.strictObject({
  lease: instanceLeaseInspectionSchema,
  /** What the instance claims; absent for `detect` and for any refused takeover. */
  handoff: z.strictObject({ ticketId: safeId, runId: safeId, claimPath: z.string().min(1) }).nullable(),
});
export type InstanceTakeoverResponse = z.infer<typeof instanceTakeoverResponseSchema>;

/** Who is asking which prepared runs are waiting; an instance names only itself. */
export const takeoverQuerySchema = z.strictObject({ instanceId: safeId, profileId: safeId });
export type TakeoverQuery = z.infer<typeof takeoverQuerySchema>;

/** A prepared run waiting for its instance; the instance claims it through `claimPath`. */
export const takeoverRequestSchema = z.strictObject({
  ticketId: safeId, runId: safeId, createdAt: z.iso.datetime(), claimPath: z.string().min(1),
});
export type TakeoverRequest = z.infer<typeof takeoverRequestSchema>;
export const takeoverRequestListSchema = z.strictObject({ takeovers: z.array(takeoverRequestSchema) });

/**
 * The Engine asking the instance to synchronise, and the instance answering.
 *
 * A takeover cannot attach the plugin to the run's persistence root — that root
 * was frozen when the instance started, so it cannot be redirected afterwards —
 * so the Engine does not try. It states what it wants and the *user* decides:
 * the instance surfaces a confirmation, and only an explicit approval is
 * reported back. A refusal and a request nobody answered are both normal
 * outcomes that leave the instance untouched.
 */
export const instanceSyncRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: safeId,
  instanceId: safeId,
  profileId: safeId,
  /** What the Engine wants synchronised, phrased for the user who has to approve it. */
  summary: z.string().min(1).max(1_000),
  requestedAt: z.iso.datetime(),
});
export type InstanceSyncRequest = z.infer<typeof instanceSyncRequestSchema>;

export const instanceSyncRequestListSchema = z.strictObject({ requests: z.array(instanceSyncRequestSchema) });

export const instanceSyncDecisionSchema = z.enum([
  /** The user approved; the instance may perform the synchronisation. */
  "approved",
  /** The user declined. The Engine reports this and does not ask again for that request. */
  "declined",
  /** Nobody answered before the request expired; treated exactly like a decline. */
  "expired",
]);
export type InstanceSyncDecision = z.infer<typeof instanceSyncDecisionSchema>;

export const instanceSyncDecisionResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: safeId,
  instanceId: safeId,
  profileId: safeId,
  decision: instanceSyncDecisionSchema,
  /** Why, in the instance's own words; shown to the operator on the Engine side. */
  detail: z.string().min(1).max(1_000),
  decidedAt: z.iso.datetime(),
});
export type InstanceSyncDecisionResponse = z.infer<typeof instanceSyncDecisionResponseSchema>;

/** The Engine asking for a synchronisation it cannot perform itself. */
export const instanceSyncRequestCreateSchema = z.strictObject({
  targetId: safeId,
  /** What to tell the user; the Engine writes the words the prompt shows. */
  summary: z.string().min(1).max(1_000),
});
export type InstanceSyncRequestCreate = z.infer<typeof instanceSyncRequestCreateSchema>;

/**
 * The liveness question the Engine asks the instance itself.
 *
 * A lease file only proves that *some* process wrote a file. Before the Engine
 * prepares a run for an instance, it asks the endpoint named in the lease to
 * prove it is that same instance: same identity, same DSH Home, same OS
 * process. Whatever answers must be the plugin running inside the instance, so
 * an arbitrary DSH process or a stale file cannot be taken over by mistake.
 */
export const instanceLivenessChallengeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  instanceId: safeId,
  profileId: safeId,
  /** The Engine states which process it expects, and the instance confirms or denies it. */
  pid: z.number().int().positive(),
  homeRoot: z.string().min(1).max(32_768),
});
export type InstanceLivenessChallenge = z.infer<typeof instanceLivenessChallengeSchema>;

export const instanceLivenessAnswerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** Always `dsh-session-maintenance`: which plugin answered, not which instance. */
  responder: z.literal("dsh-session-maintenance"),
  instanceId: safeId,
  profileId: safeId,
  /** The plugin's own view of its identity; a mismatch is a refusal, not a repair. */
  matched: z.boolean(),
  pid: z.number().int().positive(),
  homeRoot: z.string().min(1).max(32_768),
  /** `idle` until the Engine hands over a prepared run through the lease. */
  state: instanceLeaseStateSchema,
  attachedRunId: safeId.nullable(),
});
export type InstanceLivenessAnswer = z.infer<typeof instanceLivenessAnswerSchema>;
