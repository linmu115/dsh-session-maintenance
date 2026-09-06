import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { z, ZodError } from "zod";

import {
  SessionMaintenanceError,
  codexImportRequestSchema,
  codexImportJobQuerySchema,
  dashboardLaunchRequestSchema,
  continuationPreviewRequestSchema,
  resolutionContinuationRequestSchema,
  diffRequestSchema,
  checkpointRestoreBodySchema,
  createCheckpointRequestSchema,
  maintenanceSettingsPatchSchema,
  planQuerySchema,
  planRequestSchema,
  restoreOperationRequestSchema,
  platformSessionResolutionRequestSchema,
  scanRequestSchema,
  sessionQuerySchema,
  statusEventQuerySchema,
  transactionQuerySchema,
  type DiffRequest,
  type ContinuationPreviewRequest,
  type CreateContinuationRequest,
  type JsonValue,
  type PlanRequest,
  type ResolutionContinuationRequest,
  type SessionQuery,
  type CheckpointRestoreRequest,
  type CreateCheckpointRequest,
  type MaintenanceSettingsPatch,
  type TransactionQuery,
  type PlanQuery,
  type StatusEventQuery,
  type CanonicalSessionMaintenancePatch,
} from "@linmu/dsh-session-contracts";
import { ProjectionRuntimeStreamError } from "@linmu/dsh-session-projection-lifecycle";

import type { SessionMaintenanceEngine } from "../engine.js";
import type { JobRunner } from "../jobs/job-runner.js";
import type { JobStore } from "../jobs/job-store.js";
import { allowedOrigin, authorized } from "./auth.js";
import { HttpBodyError, readJsonBody } from "./body.js";
import { routeRetentionRequest } from "./retention-routes.js";
import { streamJobEvents, streamStatusEvents } from "./sse.js";
import { hasUiSessionCookie, type UiSessionManager } from "./ui-session.js";
import {
  DASHBOARD_CANONICAL_MIGRATION_PREVIEW_PATH,
  DASHBOARD_CANONICAL_WORKSPACES_PATH,
  DASHBOARD_CANONICAL_PROJECTS_PATH,
} from "./dashboard.js";

export interface RouteContext {
  readonly engine: SessionMaintenanceEngine;
  readonly jobs: JobRunner;
  readonly jobStore: JobStore;
  readonly token: string;
  readonly origin: string;
  readonly uiSessions: UiSessionManager;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

/** Projection failures retain their WAL/recovery wrapper; expose only typed metadata causes to clients. */
function metadataFailureCause(error: unknown): SessionMaintenanceError | undefined {
  const seen = new Set<Error>();
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error && !seen.has(current); depth += 1) {
    seen.add(current);
    if (current instanceof SessionMaintenanceError &&
        (current.code === "HISTORICAL_METADATA_UNAVAILABLE" || current.code === "OBJECT_CORRUPT")) return current;
    current = current.cause;
  }
  return undefined;
}

async function sendNdjson(response: ServerResponse, frames: AsyncIterable<string>): Promise<void> {
  response.statusCode = 200;
  response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  for await (const frame of frames) {
    if (!response.write(frame)) await once(response, "drain");
  }
  response.end();
}

function errorBody(code: string, message: string): JsonValue {
  return { error: { code, message } };
}

const emptyRequestSchema = z.strictObject({});
const runtimeBrokerIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9@/._:-]{0,255}$/u);
const runtimeBrokerPrepareSchema = z.strictObject({
  schemaVersion: z.literal(1),
  client: z.strictObject({ kind: z.enum(["launcher", "plugin", "cli"]), id: runtimeBrokerIdSchema }),
  runtimeClientId: runtimeBrokerIdSchema,
  instanceId: runtimeBrokerIdSchema,
  profileId: runtimeBrokerIdSchema,
  dshVersion: z.string().min(1).max(100),
  maintenanceEndpoint: z.string().url(),
  branchId: runtimeBrokerIdSchema,
  environment: z.strictObject({
    packageVersions: z.record(z.string(), z.string()),
    runtimeCapabilities: z.array(z.string().min(1).max(200)).max(200),
  }),
  pinnedAdapterId: runtimeBrokerIdSchema.nullable(),
  projectSelection: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("all") }),
    z.strictObject({ kind: z.literal("ids"), projectIds: z.array(runtimeBrokerIdSchema).min(1) }),
  ]),
});
const runtimeBrokerAttachSchema = z.strictObject({
  schemaVersion: z.literal(1), clientId: runtimeBrokerIdSchema,
  runId: runtimeBrokerIdSchema, temporaryPersistenceRootId: runtimeBrokerIdSchema,
  attachedAt: z.iso.datetime(),
});
const runtimeBrokerAppendSchema = z.strictObject({
  schemaVersion: z.literal(1),
  clientId: runtimeBrokerIdSchema,
  operation: z.strictObject({
    runId: runtimeBrokerIdSchema,
    operationId: runtimeBrokerIdSchema,
    nativeSessionId: runtimeBrokerIdSchema,
    nativeRevision: z.number().int().nonnegative(),
    payload: z.unknown(),
    observedAt: z.iso.datetime(),
  }),
});
const runtimeBrokerRegisterSessionSchema = z.strictObject({
  schemaVersion: z.literal(1), clientId: runtimeBrokerIdSchema,
  runId: runtimeBrokerIdSchema, nativeSessionId: runtimeBrokerIdSchema,
  header: z.unknown(), title: z.string().max(500), adapterMetadata: z.unknown().optional(),
});
const runtimeBrokerFlushSchema = z.strictObject({
  schemaVersion: z.literal(1), clientId: runtimeBrokerIdSchema,
  runId: runtimeBrokerIdSchema, nativeSessionId: runtimeBrokerIdSchema,
});
const runtimeBrokerCloseSchema = z.strictObject({
  schemaVersion: z.literal(1), clientId: runtimeBrokerIdSchema,
  runId: runtimeBrokerIdSchema, reason: z.enum(["normal", "recovery"]),
});
const runtimeBrokerDrainSchema = z.strictObject({
  schemaVersion: z.literal(1), clientId: runtimeBrokerIdSchema,
  runId: runtimeBrokerIdSchema, runtimeFlushCompletedAt: z.iso.datetime(),
});
const projectionHotLimitSchema = z.coerce.number().int().min(0).max(1_000);
const stableReferenceRequestSchema = z.strictObject({
  referenceType: z.enum(["annotation", "sticker", "obsidian-reference"]),
  logicalSessionId: z.string().min(1).nullable(),
  logicalAnchorId: z.string().min(1).nullable(),
  legacyNativeSessionId: z.string().min(1).nullable(),
  legacyNativeAnchorId: z.string().min(1).nullable(),
}).refine((value) => value.logicalSessionId !== null || value.legacyNativeSessionId !== null, {
  message: "A logical or legacy session ID is required",
});
const canonicalSessionPatchSchema = z.strictObject({
  title: z.string().max(500).optional(),
  tags: z.array(z.string().max(200)).max(100).optional(),
  workspaceId: z.string().min(1).nullable().optional(),
  displayOrder: z.number().int().nonnegative().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
});
const adapterSelectionRequestSchema = z.strictObject({
  instanceId: z.string().min(1),
  adapterId: z.string().min(1),
});
const canonicalMigrationActivationSchema = z.strictObject({
  sourceDigest: z.string().min(1),
});

function pathId(value: string): string {
  const decoded = decodeURIComponent(value);
  if (decoded.length === 0 || decoded.length > 256 || /[\\/\u0000-\u001f\u007f]/u.test(decoded)) {
    throw new HttpBodyError(400, "Invalid path identifier");
  }
  return decoded;
}

export async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
): Promise<void> {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  const url = new URL(request.url ?? "/", context.origin);
  if (request.method === "GET" && url.pathname === "/v1/health") {
    send(response, 200, { status: await context.engine.status() });
    return;
  }
  if (request.method === "GET" && url.pathname === "/ui/claim") {
    const keys = [...url.searchParams.keys()];
    const code = url.searchParams.get("code");
    const claimed = keys.length === 1 && keys[0] === "code" && code !== null
      ? context.uiSessions.claim(code)
      : undefined;
    if (claimed === undefined) {
      send(response, 410, errorBody("LAUNCH_CODE_INVALID", "Dashboard launch code is invalid or expired"));
      return;
    }
    response.statusCode = 303;
    response.setHeader("set-cookie", claimed.cookie);
    response.setHeader("location", "/dashboard/");
    response.end();
    return;
  }
  const bearer = authorized(request, context.token);
  if (request.method === "POST" && url.pathname === "/v1/ui/launch-code") {
    if (!bearer) {
      send(response, 401, errorBody("UNAUTHORIZED", "Trusted Engine authentication required"));
      return;
    }
    if (!allowedOrigin(request, context.origin)) {
      send(response, 403, errorBody("ORIGIN_FORBIDDEN", "Origin is not the loopback server origin"));
      return;
    }
    try {
      const body = dashboardLaunchRequestSchema.parse(await readJsonBody(request));
      const launch = context.uiSessions.issue(context.origin, body.logicalSessionId);
      send(response, 201, { launch: { url: launch.url, expiresAt: launch.expiresAt } });
    } catch (error) {
      if (error instanceof HttpBodyError) send(response, error.status, errorBody("INVALID_REQUEST", error.message));
      else if (error instanceof ZodError) send(response, 400, errorBody("INVALID_REQUEST", "Request does not match the API schema"));
      else send(response, 500, errorBody("INTERNAL_ERROR", "Unable to issue Dashboard launch code"));
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/ui/session") {
    const session = context.uiSessions.session(request, context.origin);
    if (session === undefined) {
      send(response, 403, errorBody("UI_SESSION_FORBIDDEN", "Dashboard session or exact Origin is missing"));
      return;
    }
    send(response, 200, { session: {
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
      ...(session.initialLogicalSessionId === undefined ? {} : { initialLogicalSessionId: session.initialLogicalSessionId }),
    } });
    return;
  }
  const uiAuthorized = !bearer && context.uiSessions.authorized(request, context.origin);
  if (!bearer && !uiAuthorized) {
    send(response, hasUiSessionCookie(request) ? 403 : 401, errorBody(
      hasUiSessionCookie(request) ? "UI_SESSION_FORBIDDEN" : "UNAUTHORIZED",
      hasUiSessionCookie(request) ? "Dashboard session, exact Origin and CSRF are required" : "Authentication required",
    ));
    return;
  }
  if (bearer && !allowedOrigin(request, context.origin)) {
    send(response, 403, errorBody("ORIGIN_FORBIDDEN", "Origin is not the loopback server origin"));
    return;
  }

  try {
    if (await routeRetentionRequest(request, response, url, context.engine.retention)) return;
    if (request.method === "GET" && url.pathname === "/v1/instances") {
      send(response, 200, { instances: await context.engine.listInstances() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/adapters/registry") {
      send(response, 200, { adapters: context.engine.adapterRegistry.list() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/references/resolve") {
      const input = stableReferenceRequestSchema.parse(await readJsonBody(request));
      send(response, 200, { resolution: await context.engine.resolveStableReference(input as never) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/runtime-broker/runs/prepare") {
      const body = runtimeBrokerPrepareSchema.parse(await readJsonBody(request));
      send(response, 201, { run: await context.engine.prepareProjectionRuntimeRun(body as never) });
      return;
    }
    const runtimeBrokerAttach = /^\/v1\/runtime-broker\/runs\/([^/]+)\/attach$/u.exec(url.pathname);
    if (request.method === "POST" && runtimeBrokerAttach !== null) {
      const body = runtimeBrokerAttachSchema.parse(await readJsonBody(request));
      if (decodeURIComponent(runtimeBrokerAttach[1]!) !== body.runId) throw new HttpBodyError(400, "runId path/body mismatch");
      send(response, 200, { run: await context.engine.attachProjectionRuntimeRun(body as never) });
      return;
    }
    const runtimeBrokerAppend = /^\/v1\/runtime-broker\/runs\/([^/]+)\/append$/u.exec(url.pathname);
    if (request.method === "POST" && runtimeBrokerAppend !== null) {
      const body = runtimeBrokerAppendSchema.parse(await readJsonBody(request, 4 * 1024 * 1024));
      if (decodeURIComponent(runtimeBrokerAppend[1]!) !== body.operation.runId) throw new HttpBodyError(400, "runId path/body mismatch");
      send(response, 200, { schemaVersion: 1, receipt: await context.engine.appendProjectionRuntimeEvent(body.clientId, body.operation as never) });
      return;
    }
    const runtimeBrokerRegisterSession = /^\/v1\/runtime-broker\/runs\/([^/]+)\/sessions$/u.exec(url.pathname);
    if (request.method === "POST" && runtimeBrokerRegisterSession !== null) {
      const body = runtimeBrokerRegisterSessionSchema.parse(await readJsonBody(request));
      if (decodeURIComponent(runtimeBrokerRegisterSession[1]!) !== body.runId) throw new HttpBodyError(400, "runId path/body mismatch");
      send(response, 201, { session: await context.engine.registerProjectionRuntimeSession(body as never) });
      return;
    }
    const runtimeBrokerFlush = /^\/v1\/runtime-broker\/runs\/([^/]+)\/flush$/u.exec(url.pathname);
    if (request.method === "POST" && runtimeBrokerFlush !== null) {
      const body = runtimeBrokerFlushSchema.parse(await readJsonBody(request));
      if (decodeURIComponent(runtimeBrokerFlush[1]!) !== body.runId) throw new HttpBodyError(400, "runId path/body mismatch");
      send(response, 200, await context.engine.flushProjectionRuntimeSession(body as never));
      return;
    }
    const runtimeBrokerClose = /^\/v1\/runtime-broker\/runs\/([^/]+)\/close$/u.exec(url.pathname);
    if (request.method === "POST" && runtimeBrokerClose !== null) {
      const body = runtimeBrokerCloseSchema.parse(await readJsonBody(request));
      if (decodeURIComponent(runtimeBrokerClose[1]!) !== body.runId) throw new HttpBodyError(400, "runId path/body mismatch");
      send(response, 200, { run: await context.engine.closeProjectionRuntimeRun(body as never) });
      return;
    }
    const runtimeBrokerDrain = /^\/v1\/runtime-broker\/runs\/([^/]+)\/drain$/u.exec(url.pathname);
    if (request.method === "POST" && runtimeBrokerDrain !== null) {
      const body = runtimeBrokerDrainSchema.parse(await readJsonBody(request));
      if (decodeURIComponent(runtimeBrokerDrain[1]!) !== body.runId) throw new HttpBodyError(400, "runId path/body mismatch");
      send(response, 200, { run: await context.engine.drainProjectionRuntimeRun(body as never) });
      return;
    }
    const projectionIdentity = /^\/v1\/projection-runs\/([^/]+)\/sessions\/([^/]+)\/identity$/u.exec(url.pathname);
    if (request.method === "GET" && projectionIdentity !== null) {
      const resolution = context.engine.sessionQueries.resolveProjectionSessionIdentity(pathId(projectionIdentity[1]!), pathId(projectionIdentity[2]!));
      if (resolution === undefined) send(response, 404, errorBody("SESSION_NOT_MAPPED", "Session is not mapped in this active projection run"));
      else send(response, 200, { resolution });
      return;
    }
    const projectionDelete = /^\/v1\/projection-runs\/([^/]+)\/sessions\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "DELETE" && projectionDelete !== null) {
      const runId = pathId(projectionDelete[1]!);
      const nativeSessionId = pathId(projectionDelete[2]!);
      const receipt = await context.engine.sessionCommands.deleteProjectedSession(runId, nativeSessionId);
      if (receipt === undefined) send(response, 404, errorBody("SESSION_NOT_MAPPED", "Session is not mapped in this active projection run"));
      else send(response, receipt.deletion.state === "pending-delete" ? 202 : 200, receipt);
      return;
    }
    const projectionRuntimeMatch = /^\/v1\/projection-runs\/([^/]+)\/runtime$/u.exec(url.pathname);
    if (request.method === "GET" && projectionRuntimeMatch !== null) {
      const runId = decodeURIComponent(projectionRuntimeMatch[1]!) as never;
      const snapshot = await context.engine.getProjectionRuntimeSnapshot(runId);
      if (snapshot === undefined) send(response, 404, { error: "projection run not found" });
      else send(response, 200, snapshot);
      return;
    }
    const projectionRuntimeStream = /^\/v1\/projection-runs\/([^/]+)\/runtime\/stream$/u.exec(url.pathname);
    if (request.method === "GET" && projectionRuntimeStream !== null) {
      const runId = decodeURIComponent(projectionRuntimeStream[1]!) as never;
      const hotLimit = projectionHotLimitSchema.parse(url.searchParams.get("hotLimit") ?? 200);
      const stream = await context.engine.getProjectionRuntimeStream(runId, hotLimit);
      if (stream === undefined) send(response, 404, errorBody("PROJECTION_RUN_NOT_FOUND", "Projection run not found"));
      else await sendNdjson(response, stream.frames);
      return;
    }
    const projectionRuntimeSessionStream = /^\/v1\/projection-runs\/([^/]+)\/runtime\/sessions\/([^/]+)\/stream$/u.exec(url.pathname);
    if (request.method === "GET" && projectionRuntimeSessionStream !== null) {
      const runId = decodeURIComponent(projectionRuntimeSessionStream[1]!) as never;
      const nativeSessionId = pathId(projectionRuntimeSessionStream[2]!) as never;
      const stream = await context.engine.getProjectionRuntimeSessionStream(runId, nativeSessionId);
      if (stream === undefined) send(response, 404, errorBody("PROJECTION_SESSION_NOT_FOUND", "Projection session not found"));
      else await sendNdjson(response, stream.frames);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/session-resolution") {
      const key = platformSessionResolutionRequestSchema.parse(await readJsonBody(request));
      const resolution = await context.engine.resolvePlatformSession(key);
      if (resolution === undefined) { send(response, 404, errorBody("SESSION_NOT_MAPPED", "Platform session is not mapped")); return; }
      send(response, 200, { resolution });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/overview") {
      send(response, 200, { overview: await context.engine.overview() });
      return;
    }
    if (request.method === "GET" && url.pathname === DASHBOARD_CANONICAL_MIGRATION_PREVIEW_PATH) {
      send(response, 200, { preview: await context.engine.previewCanonicalMigration() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/canonical/migration/activate") {
      const body = canonicalMigrationActivationSchema.parse(await readJsonBody(request));
      send(response, 201, { activation: await context.engine.activateCanonicalMigration(body.sourceDigest) });
      return;
    }
    if (request.method === "GET" && url.pathname === DASHBOARD_CANONICAL_WORKSPACES_PATH) {
      send(response, 200, { directory: await context.engine.sessionQueries.readCanonicalWorkspaceDirectory() });
      return;
    }
    if (request.method === "GET" && url.pathname === DASHBOARD_CANONICAL_PROJECTS_PATH) {
      send(response, 200, { directory: await context.engine.sessionQueries.readCanonicalProjectDirectory() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/canonical/recently-deleted") {
      send(response, 200, { sessions: await context.engine.sessionQueries.readRecentlyDeleted() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/canonical/run-center") {
      send(response, 200, { runs: context.engine.sessionQueries.readRunCenter() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/canonical/adapters") {
      send(response, 200, { adapters: context.engine.adapterRegistry.list().map((registration) => ({
        manifest: registration.manifest,
        enabled: registration.enabled,
        sourceKind: registration.source.kind,
        sourceLabel: registration.source.kind === "local" ? `local:${registration.manifest.id}`
          : registration.source.kind === "generation" ? `generation:${registration.source.generationId}`
            : `npm:${registration.source.packageName}`,
      })) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/canonical/adapters/select") {
      const body = adapterSelectionRequestSchema.parse(await readJsonBody(request));
      const instance = context.engine.instances.find((item) => item.id === body.instanceId && item.platform === "dsh");
      if (instance === undefined) {
        send(response, 404, errorBody("DSH_INSTANCE_NOT_FOUND", "Registered DSH instance not found"));
        return;
      }
      const selection = await context.engine.adapterRegistry.select({
        environment: {
          dshVersion: instance.platformVersion,
          packageVersions: {
            "@deepseek-ai/dsh-session": instance.platformVersion,
            "@deepseek-ai/dsh-session-persistence": instance.platformVersion,
          },
          runtimeCapabilities: ["sessionPersistence", "legacySessionPersistence"],
        },
        pinnedAdapterId: body.adapterId as never,
      });
      send(response, 200, { selection: {
        adapterId: selection.adapterId,
        manifest: selection.registration.manifest,
        probe: selection.probe,
        reason: selection.reason,
        verificationRunId: selection.verificationRunId,
      } });
      return;
    }
    const canonicalWorkspace = url.pathname.match(/^\/v1\/canonical\/workspaces\/([^/]+)$/u);
    if (request.method === "DELETE" && canonicalWorkspace !== null) {
      const deleted = await context.engine.runWrite("session-maintenance", () => context.engine.sessionCommands.deleteWorkspace(pathId(canonicalWorkspace[1]!)));
      if (!deleted) send(response, 404, errorBody("CANONICAL_WORKSPACE_NOT_FOUND", "Canonical workspace not found"));
      else send(response, 200, { deleted: true });
      return;
    }
    const canonicalSession = url.pathname.match(/^\/v1\/canonical\/sessions\/([^/]+)$/u);
    if (request.method === "GET" && canonicalSession !== null) {
      const detail = await context.engine.sessionQueries.readCanonicalDashboardSession(
        pathId(canonicalSession[1]!),
      );
      if (detail === undefined) {
        send(response, 404, errorBody("CANONICAL_SESSION_NOT_FOUND", "Canonical session not found"));
      } else {
        send(response, 200, { session: detail });
      }
      return;
    }
    if (request.method === "PATCH" && canonicalSession !== null) {
      const detail = await context.engine.sessionCommands.updateSession(
        pathId(canonicalSession[1]!),
        canonicalSessionPatchSchema.parse(await readJsonBody(request)) as CanonicalSessionMaintenancePatch,
      );
      if (detail === undefined) send(response, 404, errorBody("CANONICAL_SESSION_NOT_FOUND", "Canonical session not found"));
      else send(response, 200, { session: detail });
      return;
    }
    if (request.method === "DELETE" && canonicalSession !== null) {
      const logicalSessionId = pathId(canonicalSession[1]!);
      const result = await context.engine.sessionCommands.deleteSession(logicalSessionId);
      if (result === undefined) send(response, 404, errorBody("CANONICAL_SESSION_NOT_FOUND", "Canonical session not found"));
      else send(response, result.state === "pending-delete" ? 202 : 200, { deletion: result });
      return;
    }
    const canonicalRestore = url.pathname.match(/^\/v1\/canonical\/sessions\/([^/]+)\/restore$/u);
    if (request.method === "POST" && canonicalRestore !== null) {
      emptyRequestSchema.parse(await readJsonBody(request));
      const restored = await context.engine.runWrite("session-maintenance", () => context.engine.sessionCommands.restoreSession(pathId(canonicalRestore[1]!)));
      if (restored === undefined) send(response, 404, errorBody("CANONICAL_SESSION_NOT_DELETED", "Canonical session is not deleted"));
      else send(response, 200, { restoration: restored });
      return;
    }
    if (request.method === "GET" && (url.pathname === "/v1/status-events" || url.pathname === "/v1/status-events/stream")) {
      const query = statusEventQuerySchema.parse({
        ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {}),
        ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
        ...(url.searchParams.has("runId") ? { runId: url.searchParams.get("runId") } : {}),
        ...(url.searchParams.has("logicalSessionId") ? { logicalSessionId: url.searchParams.get("logicalSessionId") } : {}),
        ...(url.searchParams.has("operationId") ? { operationId: url.searchParams.get("operationId") } : {}),
        ...(url.searchParams.has("stage") ? { stage: url.searchParams.get("stage") } : {}),
        ...(url.searchParams.has("spanId") ? { spanId: url.searchParams.get("spanId") } : {}),
      }) as unknown as StatusEventQuery;
      if (url.pathname.endsWith("/stream")) {
        await streamStatusEvents(response, context.engine.statusLog, query);
      } else {
        send(response, 200, { page: await context.engine.listStatusEvents(query) });
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/sessions") {
      const query = sessionQuerySchema.parse({
        ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {}),
        ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
        ...(url.searchParams.has("platform") ? { platform: url.searchParams.get("platform") } : {}),
        ...(url.searchParams.has("status") ? { status: url.searchParams.get("status") } : {}),
        ...(url.searchParams.has("workspace")
          ? { workspaceId: url.searchParams.get("workspace") === "__unclassified__" ? null : url.searchParams.get("workspace") }
          : {}),
      });
      send(response, 200, { page: await context.engine.listSessions(query as unknown as SessionQuery) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/workspaces") {
      send(response, 200, { workspaces: await context.engine.listWorkspaces() });
      return;
    }
    const graph = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/graph$/u);
    if (request.method === "GET" && graph !== null) {
      send(response, 200, { graph: await context.engine.getGraph(pathId(graph[1]!), url.searchParams.get("cursor") ?? undefined) });
      return;
    }
    const version = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/versions\/([^/]+)$/u);
    if (request.method === "GET" && version !== null) {
      send(response, 200, { version: await context.engine.getVersionContent(
        pathId(version[1]!),
        pathId(version[2]!),
      ) });
      return;
    }
    const session = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/u);
    if (request.method === "GET" && session !== null) {
      send(response, 200, { session: await context.engine.getSessionDetail(pathId(session[1]!)) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/diffs") {
      send(response, 200, { diff: await context.engine.diff(diffRequestSchema.parse(await readJsonBody(request)) as unknown as DiffRequest) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/continuations/preview") {
      const body = continuationPreviewRequestSchema.parse(await readJsonBody(request)) as unknown as ContinuationPreviewRequest;
      send(response, 200, { preview: await context.engine.previewContinuation(body) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/continuations/resolutions/preview") {
      const body = resolutionContinuationRequestSchema.parse(await readJsonBody(request)) as unknown as ResolutionContinuationRequest;
      send(response, 200, { preview: await context.engine.previewResolutionContinuation(body) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/continuations/resolutions") {
      const body = resolutionContinuationRequestSchema.parse(await readJsonBody(request)) as unknown as ResolutionContinuationRequest;
      send(response, 201, { continuation: await context.engine.createResolutionContinuation(body) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/continuations") {
      const body = continuationPreviewRequestSchema.parse(await readJsonBody(request)) as unknown as CreateContinuationRequest;
      send(response, 201, { continuation: await context.engine.createContinuation(body) });
      return;
    }
    const continuationRecover = url.pathname.match(/^\/v1\/continuations\/([^/]+)\/recover$/u);
    if (request.method === "POST" && continuationRecover !== null) {
      emptyRequestSchema.parse(await readJsonBody(request));
      send(response, 200, { continuation: await context.engine.recoverContinuation(pathId(continuationRecover[1]!)) });
      return;
    }
    const continuation = url.pathname.match(/^\/v1\/continuations\/([^/]+)$/u);
    if (request.method === "GET" && continuation !== null) {
      const stored = await context.engine.getContinuation(pathId(continuation[1]!));
      if (stored === undefined) { send(response, 404, errorBody("CONTINUATION_NOT_FOUND", "Continuation not found")); return; }
      send(response, 200, { continuation: stored });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/jobs") {
      const entries = [...url.searchParams.entries()];
      if (new Set(entries.map(([key]) => key)).size !== entries.length) {
        send(response, 400, errorBody("INVALID_REQUEST", "Duplicate query parameter")); return;
      }
      const query = codexImportJobQuerySchema.parse(Object.fromEntries(entries));
      send(response, 200, context.jobStore.listCodexImports(query.limit));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/jobs/codex-import") {
      const body = codexImportRequestSchema.parse(await readJsonBody(request));
      send(response, 202, { job: await context.engine.runWrite("job-enqueue", () => context.jobs.enqueueCodexImport(body)) });
      return;
    }
    const importControl = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/(cancel|resume)$/u);
    if (request.method === "POST" && importControl !== null) {
      emptyRequestSchema.parse(await readJsonBody(request));
      const id = pathId(importControl[1]!);
      const job = importControl[2] === "cancel"
        ? await context.jobs.cancelCodexImport(id)
        : await context.engine.runWrite("job-control", () => context.jobs.resumeCodexImport(id));
      send(response, 202, { job });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/jobs/scan") {
      const body = scanRequestSchema.parse(await readJsonBody(request));
      send(response, 202, { job: await context.engine.runWrite("job-enqueue", () => context.jobs.enqueueScan(body.instanceIds)) });
      return;
    }
    const jobEvents = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/events$/u);
    if (request.method === "GET" && jobEvents !== null) {
      const id = pathId(jobEvents[1]!);
      if (context.jobStore.get(id) === undefined) { send(response, 404, errorBody("NOT_FOUND", "Job not found")); return; }
      const last = request.headers["last-event-id"] ?? url.searchParams.get("after") ?? "-1";
      const after = Number.parseInt(Array.isArray(last) ? last[0] ?? "-1" : last, 10);
      await streamJobEvents(response, context.jobStore, id, Number.isSafeInteger(after) ? after : -1);
      return;
    }
    const job = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/u);
    if (request.method === "GET" && job !== null) {
      const stored = context.jobStore.get(pathId(job[1]!));
      if (stored === undefined) { send(response, 404, errorBody("NOT_FOUND", "Job not found")); return; }
      send(response, 200, { job: stored.ref, ...(stored.result === undefined ? {} : { result: stored.result }) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/plans") {
      const query = planQuerySchema.parse({
        ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {}),
        ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
        ...(url.searchParams.has("risk") ? { risk: url.searchParams.get("risk") } : {}),
      }) as unknown as PlanQuery;
      send(response, 200, { page: await context.engine.listPlans(query) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/plans") {
      send(response, 201, { plan: await context.engine.createPlan(planRequestSchema.parse(await readJsonBody(request)) as unknown as PlanRequest) });
      return;
    }
    const planApply = url.pathname.match(/^\/v1\/plans\/([^/]+)\/apply$/u);
    if (request.method === "POST" && planApply !== null) {
      emptyRequestSchema.parse(await readJsonBody(request));
      send(response, 202, { job: await context.engine.runWrite("job-enqueue", () => context.jobs.enqueueApply(pathId(planApply[1]!))) });
      return;
    }
    const plan = url.pathname.match(/^\/v1\/plans\/([^/]+)$/u);
    if (request.method === "GET" && plan !== null) {
      const stored = await context.engine.getPlan(pathId(plan[1]!));
      if (stored === undefined) { send(response, 404, errorBody("NOT_FOUND", "Plan not found")); return; }
      send(response, 200, { plan: stored });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/transactions") {
      const query = transactionQuerySchema.parse({
        ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {}),
        ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
        ...(url.searchParams.has("status") ? { status: url.searchParams.get("status") } : {}),
      }) as unknown as TransactionQuery;
      send(response, 200, { page: await context.engine.listTransactions(query) });
      return;
    }
    const restoreConfirmation = url.pathname.match(/^\/v1\/transactions\/([^/]+)\/restore-confirmation$/u);
    if (request.method === "POST" && restoreConfirmation !== null) {
      emptyRequestSchema.parse(await readJsonBody(request));
      send(response, 201, { confirmation: await context.engine.issueRestoreConfirmation(pathId(restoreConfirmation[1]!)) });
      return;
    }
    const transactionRestore = url.pathname.match(/^\/v1\/transactions\/([^/]+)\/restore$/u);
    if (request.method === "POST" && transactionRestore !== null) {
      const body = restoreOperationRequestSchema.parse(await readJsonBody(request));
      send(response, 202, { job: await context.engine.runWrite("job-enqueue", () => context.jobs.enqueueRestore({
        transactionId: pathId(transactionRestore[1]!),
        confirmationToken: body.confirmationToken,
      })) });
      return;
    }
    const recoveryConfirmation = url.pathname.match(/^\/v1\/transactions\/([^/]+)\/recovery-confirmation$/u);
    if (request.method === "POST" && recoveryConfirmation !== null) {
      emptyRequestSchema.parse(await readJsonBody(request));
      send(response, 201, { confirmation: await context.engine.issueRecoveryConfirmation(pathId(recoveryConfirmation[1]!)) });
      return;
    }
    const transactionRecover = url.pathname.match(/^\/v1\/transactions\/([^/]+)\/recover$/u);
    if (request.method === "POST" && transactionRecover !== null) {
      const body = restoreOperationRequestSchema.parse(await readJsonBody(request));
      send(response, 202, { job: await context.engine.runWrite("job-enqueue", () => context.jobs.enqueueRecover({
        transactionId: pathId(transactionRecover[1]!),
        confirmationToken: body.confirmationToken,
      })) });
      return;
    }
    const transaction = url.pathname.match(/^\/v1\/transactions\/([^/]+)$/u);
    if (request.method === "GET" && transaction !== null) {
      const detail = await context.engine.getTransactionDetail(pathId(transaction[1]!));
      if (detail === undefined) { send(response, 404, errorBody("TRANSACTION_NOT_FOUND", "Transaction not found")); return; }
      send(response, 200, { detail });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/checkpoints") {
      send(response, 200, { checkpoints: await context.engine.listCheckpoints() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/checkpoints") {
      send(response, 201, { checkpoint: await context.engine.createCheckpoint(
        createCheckpointRequestSchema.parse(await readJsonBody(request)) as unknown as CreateCheckpointRequest,
      ) });
      return;
    }
    const checkpointRestore = url.pathname.match(/^\/v1\/checkpoints\/([^/]+)\/restore-plan$/u);
    if (request.method === "POST" && checkpointRestore !== null) {
      const body = checkpointRestoreBodySchema.parse(await readJsonBody(request));
      const input: CheckpointRestoreRequest = {
        checkpointId: pathId(checkpointRestore[1]!),
        targetInstanceId: body.targetInstanceId,
        createdAt: body.createdAt,
      };
      send(response, 201, { plan: await context.engine.createCheckpointRestorePlan(input) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/diagnostics/adapters") {
      send(response, 200, { diagnostics: await context.engine.listAdapterDiagnostics() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/settings") {
      send(response, 200, { settings: await context.engine.getSettings() });
      return;
    }
    if (request.method === "PATCH" && url.pathname === "/v1/settings") {
      send(response, 200, { settings: await context.engine.patchSettings(
        maintenanceSettingsPatchSchema.parse(await readJsonBody(request)) as MaintenanceSettingsPatch,
      ) });
      return;
    }
    send(response, 404, errorBody("NOT_FOUND", "Route not found"));
  } catch (error) {
    const domainError = error instanceof SessionMaintenanceError ? error : metadataFailureCause(error);
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
    } else if (error instanceof HttpBodyError) send(response, error.status, errorBody("INVALID_REQUEST", error.message));
    else if (error instanceof ZodError) send(response, 400, errorBody("INVALID_REQUEST", "Request does not match the API schema"));
    else if (error instanceof Error && error.message.startsWith("WRITER_QUEUE_FULL")) {
      response.setHeader("retry-after", "1");
      send(response, 503, errorBody("WRITER_QUEUE_FULL", "Write queue is full; retry after pending commits drain"));
    }
    else if (error instanceof ProjectionRuntimeStreamError) send(response, 422, errorBody(error.code, error.message));
    else if (domainError !== undefined) {
      const status = domainError.code === "CAPABILITY_NOT_AVAILABLE"
        ? 501
        : domainError.code === "CONTINUATION_NOT_FOUND"
          ? 404
          : 409;
      send(response, status, errorBody(domainError.code, domainError.message));
    } else {
      const message = error instanceof Error ? error.message.replaceAll(context.token, "[REDACTED]") : "Unknown error";
      send(response, 500, errorBody("INTERNAL_ERROR", message));
    }
  }
}
