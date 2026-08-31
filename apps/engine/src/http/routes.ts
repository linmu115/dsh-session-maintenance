import type { IncomingMessage, ServerResponse } from "node:http";
import { z, ZodError } from "zod";

import {
  SessionMaintenanceError,
  dashboardLaunchRequestSchema,
  continuationPreviewRequestSchema,
  resolutionContinuationRequestSchema,
  diffRequestSchema,
  checkpointRestoreBodySchema,
  createCheckpointRequestSchema,
  maintenanceSettingsPatchSchema,
  nativeMirrorActionRequestSchema,
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
  type NativeMirrorActionRequest,
  type TransactionQuery,
  type PlanQuery,
  type StatusEventQuery,
} from "@linmu/dsh-session-contracts";

import type { SessionMaintenanceEngine } from "../engine.js";
import type { JobRunner } from "../jobs/job-runner.js";
import type { JobStore } from "../jobs/job-store.js";
import { allowedOrigin, authorized } from "./auth.js";
import { HttpBodyError, readJsonBody } from "./body.js";
import { streamJobEvents, streamStatusEvents } from "./sse.js";
import { hasUiSessionCookie, type UiSessionManager } from "./ui-session.js";
import { DASHBOARD_CANONICAL_MIGRATION_PREVIEW_PATH } from "./dashboard.js";

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

function errorBody(code: string, message: string): JsonValue {
  return { error: { code, message } };
}

const emptyRequestSchema = z.strictObject({});

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
    if (request.method === "GET" && url.pathname === "/v1/instances") {
      send(response, 200, { instances: await context.engine.listInstances() });
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
    if (request.method === "GET" && url.pathname === "/v1/mirrors") {
      send(response, 200, { mirrors: await context.engine.listNativeMirrors() });
      return;
    }
    const mirrorPreview = url.pathname.match(/^\/v1\/mirrors\/([^/]+)\/preview$/u);
    if (request.method === "POST" && mirrorPreview !== null) {
      const body = nativeMirrorActionRequestSchema.parse(await readJsonBody(request)) as NativeMirrorActionRequest;
      send(response, 200, { preview: await context.engine.previewNativeMirrorAction(pathId(mirrorPreview[1]!), body) });
      return;
    }
    const mirrorAction = url.pathname.match(/^\/v1\/mirrors\/([^/]+)\/actions$/u);
    if (request.method === "POST" && mirrorAction !== null) {
      const body = nativeMirrorActionRequestSchema.parse(await readJsonBody(request)) as NativeMirrorActionRequest;
      send(response, 200, { mirror: await context.engine.applyNativeMirrorAction(pathId(mirrorAction[1]!), body) });
      return;
    }
    const mirror = url.pathname.match(/^\/v1\/mirrors\/([^/]+)$/u);
    if (request.method === "GET" && mirror !== null) {
      const stored = await context.engine.getNativeMirror(pathId(mirror[1]!));
      if (stored === undefined) { send(response, 404, errorBody("MIRROR_NOT_ENABLED", "Native mirror is not enabled")); return; }
      send(response, 200, { mirror: stored });
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
    if (request.method === "POST" && url.pathname === "/v1/jobs/scan") {
      const body = scanRequestSchema.parse(await readJsonBody(request));
      send(response, 202, { job: context.jobs.enqueueScan(body.instanceIds) });
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
      send(response, 202, { job: context.jobs.enqueueApply(pathId(planApply[1]!)) });
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
      send(response, 202, { job: context.jobs.enqueueRestore({
        transactionId: pathId(transactionRestore[1]!),
        confirmationToken: body.confirmationToken,
      }) });
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
      send(response, 202, { job: context.jobs.enqueueRecover({
        transactionId: pathId(transactionRecover[1]!),
        confirmationToken: body.confirmationToken,
      }) });
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
    if (error instanceof HttpBodyError) send(response, error.status, errorBody("INVALID_REQUEST", error.message));
    else if (error instanceof ZodError) send(response, 400, errorBody("INVALID_REQUEST", "Request does not match the API schema"));
    else if (error instanceof SessionMaintenanceError) {
      const status = error.code === "CAPABILITY_NOT_AVAILABLE"
        ? 501
        : error.code === "CONTINUATION_NOT_FOUND"
          ? 404
          : 409;
      send(response, status, errorBody(error.code, error.message));
    } else {
      const message = error instanceof Error ? error.message.replaceAll(context.token, "[REDACTED]") : "Unknown error";
      send(response, 500, errorBody("INTERNAL_ERROR", message));
    }
  }
}
