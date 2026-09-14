import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { graphResolveSchema } from "@linmu/dsh-session-contracts";
import type { SessionMaintenanceEngine } from "../engine.js";
import { readJsonBody } from "./body.js";

const id = z.string().min(1).max(256);
const scope = z.strictObject({ runId: id });
export async function routeSessionGraph(request: IncomingMessage, response: ServerResponse, url: URL, engine: SessionMaintenanceEngine) {
  if (!url.pathname.startsWith("/v1/session-graph/") || request.method !== "POST") return false;
  const body = await readJsonBody(request, 8000), operation = url.pathname.slice("/v1/session-graph/".length);
  let result: unknown;
  if (operation === "directory") {
    const q = scope.extend({ workspaceId: id.optional(), after: id.optional() }).parse(body);
    result = await engine.sessionGraph.directory(q.runId, q.workspaceId, q.after);
  } else if (operation === "resolve") {
    const q = scope.extend({ target: graphResolveSchema }).parse(body);
    result = await engine.sessionGraph.resolve(q.runId, q.target);
  } else if (operation === "preview") {
    const q = scope.extend({ logicalSessionId: id, cursor: z.string().min(1).max(2048).optional(),
      selection: z.strictObject({ sourceVersionId: id, sourceAnchorId: id }).optional() }).parse(body);
    result = await engine.sessionGraph.preview(q.runId, q.logicalSessionId, q.cursor, q.selection);
  } else if (operation === "relations") {
    const q = scope.extend({ after: id.optional() }).parse(body);
    result = await engine.sessionGraph.relations(q.runId, q.after);
  } else return false;
  response.statusCode = 200; response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(result)); return true;
}
