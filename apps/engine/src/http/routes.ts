import type { IncomingMessage, ServerResponse } from "node:http";
import { ZodError } from "zod";

import {
  SessionMaintenanceError,
  continuationPreviewRequestSchema,
  resolutionContinuationRequestSchema,
  diffRequestSchema,
  planRequestSchema,
  scanRequestSchema,
  sessionQuerySchema,
  type DiffRequest,
  type ContinuationPreviewRequest,
  type CreateContinuationRequest,
  type JsonValue,
  type PlanRequest,
  type ResolutionContinuationRequest,
  type SessionQuery,
} from "@linmu/dsh-session-contracts";

import type { SessionMaintenanceEngine } from "../engine.js";
import type { JobRunner } from "../jobs/job-runner.js";
import type { JobStore } from "../jobs/job-store.js";
import { allowedOrigin, authorized } from "./auth.js";
import { HttpBodyError, readJsonBody } from "./body.js";
import { streamJobEvents } from "./sse.js";

export interface RouteContext {
  readonly engine: SessionMaintenanceEngine;
  readonly jobs: JobRunner;
  readonly jobStore: JobStore;
  readonly token: string;
  readonly origin: string;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

function errorBody(code: string, message: string): JsonValue {
  return { error: { code, message } };
}

export async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
): Promise<void> {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  const url = new URL(request.url ?? "/", context.origin);
  if (request.method === "GET" && url.pathname === "/v1/health") {
    send(response, 200, { status: await context.engine.status() });
    return;
  }
  if (!authorized(request, context.token)) {
    send(response, 401, errorBody("UNAUTHORIZED", "Bearer authentication required"));
    return;
  }
  if (!allowedOrigin(request, context.origin)) {
    send(response, 403, errorBody("ORIGIN_FORBIDDEN", "Origin is not the loopback server origin"));
    return;
  }

  try {
    if (request.method === "GET" && url.pathname === "/v1/instances") {
      send(response, 200, { instances: await context.engine.listInstances() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/sessions") {
      const query = sessionQuerySchema.parse({
        ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {}),
        ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
        ...(url.searchParams.has("platform") ? { platform: url.searchParams.get("platform") } : {}),
        ...(url.searchParams.has("status") ? { status: url.searchParams.get("status") } : {}),
      });
      send(response, 200, { page: await context.engine.listSessions(query as unknown as SessionQuery) });
      return;
    }
    const graph = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/graph$/u);
    if (request.method === "GET" && graph !== null) {
      send(response, 200, { graph: await context.engine.getGraph(decodeURIComponent(graph[1]!), url.searchParams.get("cursor") ?? undefined) });
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
      send(response, 200, { continuation: await context.engine.recoverContinuation(decodeURIComponent(continuationRecover[1]!)) });
      return;
    }
    const continuation = url.pathname.match(/^\/v1\/continuations\/([^/]+)$/u);
    if (request.method === "GET" && continuation !== null) {
      const stored = await context.engine.getContinuation(decodeURIComponent(continuation[1]!));
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
      const id = decodeURIComponent(jobEvents[1]!);
      if (context.jobStore.get(id) === undefined) { send(response, 404, errorBody("NOT_FOUND", "Job not found")); return; }
      const last = request.headers["last-event-id"] ?? url.searchParams.get("after") ?? "-1";
      const after = Number.parseInt(Array.isArray(last) ? last[0] ?? "-1" : last, 10);
      await streamJobEvents(response, context.jobStore, id, Number.isSafeInteger(after) ? after : -1);
      return;
    }
    const job = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/u);
    if (request.method === "GET" && job !== null) {
      const stored = context.jobStore.get(decodeURIComponent(job[1]!));
      if (stored === undefined) { send(response, 404, errorBody("NOT_FOUND", "Job not found")); return; }
      send(response, 200, { job: stored.ref, ...(stored.result === undefined ? {} : { result: stored.result }) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/plans") {
      send(response, 201, { plan: await context.engine.createPlan(planRequestSchema.parse(await readJsonBody(request)) as unknown as PlanRequest) });
      return;
    }
    const plan = url.pathname.match(/^\/v1\/plans\/([^/]+)$/u);
    if (request.method === "GET" && plan !== null) {
      const stored = await context.engine.getPlan(decodeURIComponent(plan[1]!));
      if (stored === undefined) { send(response, 404, errorBody("NOT_FOUND", "Plan not found")); return; }
      send(response, 200, { plan: stored });
      return;
    }
    if (
      request.method === "POST" &&
      (/^\/v1\/plans\/[^/]+\/apply$/u.test(url.pathname) || /^\/v1\/transactions\/[^/]+\/restore$/u.test(url.pathname))
    ) {
      throw new SessionMaintenanceError("CAPABILITY_NOT_AVAILABLE", "Write operations are unavailable in phase one");
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
