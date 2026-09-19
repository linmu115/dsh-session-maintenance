import type { IncomingMessage, ServerResponse } from "node:http";
import { learningBindSchema } from "@linmu/dsh-session-contracts";
import type { SessionMaintenanceEngine } from "../engine.js";
import { readJsonBody } from "./body.js";
export async function routeLearning(request: IncomingMessage, response: ServerResponse, url: URL, engine: SessionMaintenanceEngine) {
  const send = (value: unknown) => { response.setHeader("content-type", "application/json; charset=utf-8"); response.end(JSON.stringify(value)); };
  const mutate = async (action: (signal: AbortSignal) => Promise<unknown>) => {
    const controller = new AbortController();
    const close = () => { if (!response.writableEnded) controller.abort(); };
    response.once("close", close);
    try { send(await action(controller.signal)); } finally { response.off("close", close); }
  };
  if (url.pathname === "/v1/learning") {
    if (request.method === "GET") { send(engine.learning.directory()); return true; }
    if (request.method === "POST") { const input = learningBindSchema.parse(await readJsonBody(request)); await mutate(signal => engine.learning.bind(input, signal)); return true; }
  }
  const match = /^\/v1\/learning\/([^/]+)\/(send|collect|disable|verifySend|revalidate)$/.exec(url.pathname);
  if (!match || request.method !== "POST") return false;
  const id = decodeURIComponent(match[1]!);
  if (id.length > 256) throw new TypeError("Invalid binding ID");
  await mutate(signal => engine.learning[match[2] as "send" | "collect" | "disable" | "verifySend" | "revalidate"](id, signal)); return true;
}
