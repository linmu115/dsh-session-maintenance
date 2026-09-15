import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { SessionMaintenanceEngine } from "../engine.js";
import { SessionReaderError } from "../session-reader-queries.js";

/** Runs only after the shared Engine bearer/cookie, Origin and CSRF guards. */
export async function routeSessionReader(request: IncomingMessage, response: ServerResponse, url: URL, engine: SessionMaintenanceEngine): Promise<boolean> {
  const match = url.pathname.match(/^\/v1\/canonical\/sessions\/([^/]+)\/reader(?:\/(process|events)(?:\/([^/]+))?)?$/u);
  if (!match || request.method !== "GET") return false;
  const send = (status: number, value: unknown) => { response.statusCode = status; response.setHeader("content-type", "application/json; charset=utf-8"); response.end(JSON.stringify(value)); };
  try {
    const id = decodeURIComponent(match[1]!);
    const input = Object.fromEntries(url.searchParams);
    const snapshot = z.string().regex(/^[a-f0-9]{64}$/), cursor = z.string().regex(/^(0|[1-9][0-9]*)$/), integer = z.coerce.number().int();
    if (!match[2]) {
      const query = z.strictObject({ snapshot: snapshot.optional(), cursor: cursor.optional(), limit: integer.min(1).max(10).optional() }).parse(input);
      if (query.cursor && !query.snapshot) throw new SessionReaderError(400, "READER_SNAPSHOT_REQUIRED", "继续读取需要原会话快照。");
      send(200, await engine.sessionQueries.readSessionReader(id, query));
    } else if (match[2] === "process" && !match[3]) {
      const query = z.strictObject({ snapshot, turnId: z.string().regex(/^turn-[0-9]+$/), cursor: cursor.optional(), limit: integer.min(1).max(50).optional() }).parse(input);
      send(200, engine.sessionQueries.readonlyReader().process(id, query));
    } else if (match[2] === "events" && match[3]) {
      const query = z.strictObject({ snapshot, format: z.enum(["text", "raw"]).optional(), offset: integer.min(0).optional(), limit: integer.min(1).max(16384).optional() }).parse(input);
      send(200, engine.sessionQueries.readonlyReader().event(id, decodeURIComponent(match[3]), query));
    } else throw new SessionReaderError(404, "READER_ROUTE_NOT_FOUND", "读取入口不存在。");
  } catch (error) {
    if (error instanceof SessionReaderError) send(error.status, { error: { code: error.code, message: error.message } });
    else throw error;
  }
  return true;
}
