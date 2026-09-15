import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { graphResolveSchema, managedGraphSchema } from "@linmu/dsh-session-contracts";
import type { SessionMaintenanceEngine } from "../engine.js";
import { readJsonBody } from "./body.js";

const id = z.string().min(1).max(256);
const scope = z.strictObject({ runId: id });
export async function routeSessionGraph(request: IncomingMessage, response: ServerResponse, url: URL, engine: SessionMaintenanceEngine) {
  if (!url.pathname.startsWith("/v1/session-graph/") || request.method !== "POST") return false;
  const body = await readJsonBody(request, 512 * 1024), operation = url.pathname.slice("/v1/session-graph/".length);
  let result: unknown;
  if (operation === "ensure") {
    const q = scope.extend({ logicalSessionId: id }).parse(body); result = await engine.runWrite("graph-ensure", () => engine.sessionGraph.ensure(q.runId, q.logicalSessionId));
  } else if (operation === "load") {
    const q = scope.extend({ objectId: id }).parse(body); result = await engine.sessionGraph.load(q.runId, q.objectId);
  } else if (operation === "save") {
    const { runId, ...input } = scope.extend({ objectId: id.optional(), expectedRevision: z.number().int().nonnegative(),
      title: z.string().max(500).optional(), graph: managedGraphSchema }).parse(body); result = await engine.runWrite("graph-save", () => engine.sessionGraph.save(runId, input));
  } else if (operation === "bind") {
    const { runId, ...input } = scope.extend({ objectId: id, expectedRevision: z.number().int().nonnegative(), logicalSessionId: id }).parse(body);
    result = await engine.runWrite("graph-bind", () => engine.sessionGraph.bind(runId, input));
  } else if (operation === "remove") {
    const { runId, ...input } = scope.extend({ objectId: id, expectedRevision: z.number().int().nonnegative(), operationId: id,
      nodeIds: z.array(id).max(10000).optional(), edgeIds: z.array(id).max(20000).optional() }).parse(body);
    result = await engine.runWrite("graph-remove", () => engine.sessionGraph.remove(runId, input));
  } else if (operation === "disclosures") {
    const q = scope.extend({ objectId: id, after: id.optional() }).parse(body); result = await engine.sessionGraph.disclosures(q.runId, q.objectId, q.after);
  } else if (operation === "source-markers") {
    const q = scope.extend({ nativeSessionId: id, after: id.optional() }).parse(body); result = await engine.sessionGraph.sourceMarkers(q.runId, q.nativeSessionId, q.after);
  } else if (operation === "revoke-source") {
    const q = scope.extend({ nativeSessionId: id, referenceId: id }).parse(body);
    result = await engine.runWrite("graph-revoke-source", () => engine.sessionGraph.revokeSource(q.runId, q.nativeSessionId, q.referenceId));
  } else if (operation === "set-session-archived") {
    const q = scope.extend({ nativeSessionId: id, archived: z.boolean() }).parse(body);
    result = await engine.runWrite("graph-session-archive", () => engine.sessionGraph.setSessionArchived(q.runId, q.nativeSessionId, q.archived));
  } else if (operation === "directory") {
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
    const q = scope.extend({ logicalSessionId: id, after: id.optional() }).parse(body);
    result = await engine.sessionGraph.relations(q.runId, q.logicalSessionId, q.after);
  } else return false;
  response.statusCode = 200; response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(result)); return true;
}
