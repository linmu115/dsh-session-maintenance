import type { IncomingMessage, ServerResponse } from "node:http";
import { learningBindSchema } from "@linmu/dsh-session-contracts";
import type { SessionMaintenanceEngine } from "../engine.js";
import { readJsonBody } from "./body.js";
export async function routeLearning(request: IncomingMessage, response: ServerResponse, url: URL, engine: SessionMaintenanceEngine) {
  const send = (value: unknown) => { response.setHeader("content-type", "application/json; charset=utf-8"); response.end(JSON.stringify(value)); };
  if (url.pathname === "/v1/learning") {
    if (request.method === "GET") { send(engine.learning.directory()); return true; }
    if (request.method === "POST") { send(await engine.learning.bind(learningBindSchema.parse(await readJsonBody(request)))); return true; }
  }
  const match = /^\/v1\/learning\/([^/]+)\/(send|collect|disable|verifySend|revalidate)$/.exec(url.pathname);
  if (!match || request.method !== "POST") return false;
  const id = decodeURIComponent(match[1]!);
  if (id.length > 256) throw new TypeError("Invalid binding ID");
  send(await engine.learning[match[2] as "send" | "collect" | "disable" | "verifySend" | "revalidate"](id)); return true;
}
