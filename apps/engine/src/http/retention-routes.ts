import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { SessionMaintenanceError, retentionBatchRequestSchema, retentionExecuteRequestSchema, retentionPreviewRequestSchema, retentionVerifyRequestSchema, retentionFlatCandidateRequestSchema } from "@linmu/dsh-session-contracts";

import type { RetentionService } from "../retention-service.js";
import { HttpBodyError, readJsonBody } from "./body.js";

const empty = z.strictObject({});

/** Invoked only after the shared bearer/Origin or UI-session/CSRF gates. */
export async function routeRetentionRequest(request: IncomingMessage, response: ServerResponse, url: URL, service: RetentionService | undefined): Promise<boolean> {
  if (!url.pathname.startsWith("/v1/retention/")) return false;
  if (service === undefined) throw new SessionMaintenanceError("CAPABILITY_NOT_AVAILABLE", "Storage governance requires the coordinated Engine composition");
  if (url.searchParams.size !== 0) throw new HttpBodyError(400, "Storage governance endpoints do not accept query parameters");
  let value: unknown;
  if (request.method === "GET" && url.pathname === "/v1/retention/batches") value = { batches: service.listBatches() };
  else if (request.method === "GET" && url.pathname === "/v1/retention/registry") value = { registry: service.registry() };
  else if (request.method === "POST") {
    const body = await readJsonBody(request);
    switch (url.pathname) {
      case "/v1/retention/preview": value = { plan: await service.preview(retentionPreviewRequestSchema.parse(body).policy) }; break;
      case "/v1/retention/discover": empty.parse(body); value = { discovery: await service.discover() }; break;
      case "/v1/retention/execute": value = { batch: await service.execute(retentionExecuteRequestSchema.parse(body).planId) }; break;
      case "/v1/retention/restore": value = { batch: await service.restore(retentionBatchRequestSchema.parse(body).batchId) }; break;
      case "/v1/retention/purge": value = { batch: await service.purge(retentionBatchRequestSchema.parse(body).batchId) }; break;
      case "/v1/retention/roots": value = { root: await service.registerRoot(body) }; break;
      case "/v1/retention/sources": value = { source: await service.registerSource(body) }; break;
      case "/v1/retention/resources": value = { resource: await service.registerResource(body) }; break;
      case "/v1/retention/verify": value = { resource: await service.verify(retentionVerifyRequestSchema.parse(body).resourceId) }; break;
      case "/v1/retention/flat-candidates": value = { resource: await service.registerFlatCandidate(retentionFlatCandidateRequestSchema.parse(body).sourceId) }; break;
      default: return false;
    }
  } else return false;
  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
  return true;
}
